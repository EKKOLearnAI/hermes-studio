import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BilibiliMcpConfigurationError,
  discoverBilibiliMcpBinding,
  resolveBilibiliMcpBinding,
} from '../../packages/server/src/services/hermes/internet-execution/mcp-discovery'

describe('Bilibili MCP binding discovery', () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    previousHome = process.env.HERMES_HOME
    home = mkdtempSync(join(tmpdir(), 'internet-mcp-discovery-'))
    process.env.HERMES_HOME = home
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it('uses conventional bindings and returns only sanitized healthy discovery state', async () => {
    writeFileSync(join(home, 'config.yaml'), `
mcp_servers:
  bilibili:
    env:
      ACCESS_TOKEN: must-not-leak
    headers:
      Authorization: Bearer must-not-leak
`)
    const binding = resolveBilibiliMcpBinding('default')
    expect(binding).toEqual({
      profile: 'default', provider: 'bilibili', server: 'bilibili',
      tools: {
        'bilibili.video.search': 'search_videos',
        'bilibili.video.inspect': 'get_video_info',
      },
    })

    const calls: unknown[] = []
    const discovery = await discoverBilibiliMcpBinding('default', async (server, profile) => {
      calls.push({ server, profile })
      return {
        ok: true,
        results: [{
          server: 'bilibili',
          tools: [
            { name: 'search_videos', description: 'token=must-not-leak', input_schema: { secret: 'must-not-leak' } },
            { name: 'get_video_info', description: 'inspect', input_schema: {} },
          ],
        }],
      }
    })
    expect(calls).toEqual([{ server: 'bilibili', profile: 'default' }])
    expect(discovery).toEqual({
      profile: 'default', provider: 'bilibili', server: 'bilibili', status: 'healthy', errorCode: null,
      capabilities: {
        'bilibili.video.search': {
          capabilityId: 'bilibili.video.search', tool: 'search_videos', available: true, errorCode: null,
        },
        'bilibili.video.inspect': {
          capabilityId: 'bilibili.video.inspect', tool: 'get_video_info', available: true, errorCode: null,
        },
      },
    })
    expect(JSON.stringify(discovery)).not.toContain('must-not-leak')
  })

  it('supports bounded profile-scoped name overrides', async () => {
    const profileDir = join(home, 'profiles', 'media')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'config.yaml'), `
internet_execution:
  bilibili:
    mcp_server: bilibili_readonly
    search_tool: video_search
    inspect_tool: fetch_video_detail
`)
    expect(resolveBilibiliMcpBinding('media')).toMatchObject({
      profile: 'media', server: 'bilibili_readonly',
      tools: {
        'bilibili.video.search': 'video_search',
        'bilibili.video.inspect': 'fetch_video_detail',
      },
    })
    const discovery = await discoverBilibiliMcpBinding('media', async () => ({
      ok: true,
      results: [{ server: 'bilibili_readonly', tools: [{ name: 'video_search', description: '', input_schema: {} }] }],
    }))
    expect(discovery.status).toBe('degraded')
    expect(discovery.errorCode).toBe('MCP_TOOLS_INCOMPLETE')
    expect(discovery.capabilities['bilibili.video.inspect']).toMatchObject({
      available: false, errorCode: 'MCP_TOOL_MISSING',
    })
  })

  it('fails closed for unknown profiles, invalid sections, and mutation-shaped overrides', () => {
    expect(() => resolveBilibiliMcpBinding('missing')).toThrowError(BilibiliMcpConfigurationError)
    writeFileSync(join(home, 'config.yaml'), 'internet_execution:\n  bilibili:\n    token: must-not-load\n')
    expectConfigurationCode('MCP_CONFIG_INVALID')
    writeFileSync(join(home, 'config.yaml'), 'internet_execution:\n  bilibili:\n    search_tool: like_video\n')
    expectConfigurationCode('MCP_BINDING_UNSAFE')
    writeFileSync(join(home, 'config.yaml'), 'internet_execution:\n  bilibili:\n    mcp_server: "../other"\n')
    expectConfigurationCode('MCP_CONFIG_INVALID')
  })

  it('fails closed on missing, ambiguous, duplicate, malformed, and unavailable discovery', async () => {
    const missing = await discoverBilibiliMcpBinding('default', async () => ({ ok: true, results: [] }))
    expect(missing).toMatchObject({ status: 'unavailable', errorCode: 'MCP_SERVER_MISSING' })

    const ambiguous = await discoverBilibiliMcpBinding('default', async () => ({
      ok: true,
      results: [{ server: 'bilibili', tools: [] }, { server: 'bilibili', tools: [] }],
    }))
    expect(ambiguous).toMatchObject({ status: 'unavailable', errorCode: 'MCP_SERVER_AMBIGUOUS' })

    const duplicate = await discoverBilibiliMcpBinding('default', async () => ({
      ok: true,
      results: [{ server: 'bilibili', tools: [
        { name: 'search_videos', description: '', input_schema: {} },
        { name: 'search_videos', description: '', input_schema: {} },
      ] }],
    }))
    expect(duplicate).toMatchObject({ status: 'unavailable', errorCode: 'MCP_DISCOVERY_INVALID' })

    const rejected = await discoverBilibiliMcpBinding('default', async () => ({ ok: false, error: 'Bearer secret' }))
    expect(rejected).toMatchObject({ status: 'unavailable', errorCode: 'MCP_DISCOVERY_UNAVAILABLE' })
    expect(JSON.stringify(rejected)).not.toContain('secret')

    const thrown = await discoverBilibiliMcpBinding('default', async () => { throw new Error('private path and token') })
    expect(thrown).toMatchObject({ status: 'unavailable', errorCode: 'MCP_DISCOVERY_UNAVAILABLE' })
    expect(JSON.stringify(thrown)).not.toContain('private')
  })

  function expectConfigurationCode(code: string): void {
    try {
      resolveBilibiliMcpBinding('default')
      throw new Error('expected configuration rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(BilibiliMcpConfigurationError)
      expect((error as BilibiliMcpConfigurationError).code).toBe(code)
    }
  }
})

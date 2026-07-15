import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

describe('AgentBridgeClient.chat reasoning_effort forwarding', () => {
  it('forwards maximum reasoning_effort when provided in options', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      run_id: 'r-1',
      session_id: 's-1',
      status: 'running',
    })

    await client.chat('s-1', 'hello', undefined, undefined, 'default', {
      reasoning_effort: 'max',
    })

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      action: 'chat',
      session_id: 's-1',
      reasoning_effort: 'max',
    }))
  })

  it('omits reasoning_effort entirely when the option is not set', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      run_id: 'r-2',
      session_id: 's-2',
      status: 'running',
    })

    await client.chat('s-2', 'hello')

    const call = request.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(call).toBeDefined()
    expect(call).not.toHaveProperty('reasoning_effort')
  })

  it('omits reasoning_effort when option is an empty string', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      run_id: 'r-3',
      session_id: 's-3',
      status: 'running',
    })

    await client.chat('s-3', 'hello', undefined, undefined, undefined, {
      reasoning_effort: '',
    })

    const call = request.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(call).toBeDefined()
    expect(call).not.toHaveProperty('reasoning_effort')
  })

  it('keeps Agent Bridge on profile defaults without Workflow execution-policy plumbing', () => {
    const sources = [
      'packages/server/src/services/hermes/agent-bridge/client.ts',
      'packages/server/src/services/hermes/run-chat/types.ts',
      'packages/server/src/services/hermes/run-chat/index.ts',
      'packages/server/src/services/hermes/run-chat/handle-bridge-run.ts',
      'packages/server/src/services/hermes/agent-bridge/python/bridge_server.py',
      'packages/server/src/services/hermes/agent-bridge/python/bridge_pool.py',
      'packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py',
    ].map(path => readFileSync(path, 'utf8'))
    for (const source of sources) {
      for (const removed of ['executionPolicy', 'execution_policy', 'allowedToolsets', 'allowedTools', 'skipMemory', 'skipContextFiles']) {
        expect(source).not.toContain(removed)
      }
    }
  })

  it('does not expose a caller-controlled api mode through Agent Bridge', () => {
    const client = readFileSync('packages/server/src/services/hermes/agent-bridge/client.ts', 'utf8')
    const bridgeRun = readFileSync('packages/server/src/services/hermes/run-chat/handle-bridge-run.ts', 'utf8')
    const server = readFileSync('packages/server/src/services/hermes/agent-bridge/python/bridge_server.py', 'utf8')
    const pool = readFileSync('packages/server/src/services/hermes/agent-bridge/python/bridge_pool.py', 'utf8')
    expect(client).not.toContain('options.apiMode')
    expect(bridgeRun).not.toContain('data.apiMode')
    expect(bridgeRun).not.toContain('data.api_mode')
    expect(server).not.toContain('req.get("api_mode")')
    expect(pool).not.toContain('requested_api_mode')
    expect(pool).not.toContain('api_mode: str | None')
  })

  it('forwards workspace to chat and context estimate requests', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        ok: true,
        run_id: 'r-workspace',
        session_id: 's-workspace',
        status: 'running',
      })
      .mockResolvedValueOnce({
        ok: true,
        session_id: 's-workspace',
        token_count: 0,
        message_count: 0,
        tool_count: 0,
        system_prompt_chars: 0,
      })

    await client.chat('s-workspace', 'hello', undefined, undefined, 'default', {
      workspace: 'C:\\Users\\tester\\workspace',
    })
    await client.contextEstimate('s-workspace', [], undefined, 'default', {
      workspace: 'C:\\Users\\tester\\workspace',
    })

    expect(request.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      action: 'chat',
      session_id: 's-workspace',
      workspace: 'C:\\Users\\tester\\workspace',
    }))
    expect(request.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      action: 'context_estimate',
      session_id: 's-workspace',
      workspace: 'C:\\Users\\tester\\workspace',
    }))
  })
  it('falls back to the profile default when the Python runtime cannot apply the requested reasoning effort', () => {
    const source = readFileSync('packages/server/src/services/hermes/agent-bridge/python/bridge_pool.py', 'utf8')
    expect(source).not.toContain('raise ValueError(f"reasoning effort is unavailable: {reasoning_effort}")')
    expect(source).toContain('Non-fatal: fall through to default reasoning_config')
  })

  it('preserves reasoning and api mode across the run queue', () => {
    const source = readFileSync('packages/server/src/services/hermes/run-chat/index.ts', 'utf8')
    expect(source).toContain('reasoningEffort: data.reasoning_effort')
    expect(source).toContain('apiMode: data.apiMode')
    expect(source).toContain('reasoning_effort: next.reasoningEffort')
    expect(source).toContain('apiMode: next.apiMode')
  })

})

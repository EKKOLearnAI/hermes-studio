import { describe, expect, it, vi } from 'vitest'

describe('AgentBridgeClient.chat reasoning_effort forwarding', () => {
  it('forwards reasoning_effort when provided in options', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      run_id: 'r-1',
      session_id: 's-1',
      status: 'running',
    })

    await client.chat('s-1', 'hello', undefined, undefined, 'default', {
      reasoning_effort: 'low',
    })

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      action: 'chat',
      session_id: 's-1',
      reasoning_effort: 'low',
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

  it('forwards the same execution policy to context estimate and chat', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request')
      .mockResolvedValueOnce({
        ok: true,
        session_id: 's-policy',
        token_count: 0,
        message_count: 0,
        tool_count: 0,
        system_prompt_chars: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        run_id: 'r-policy',
        session_id: 's-policy',
        status: 'running',
      })
    const executionPolicy = { allowedToolsets: ['browser'], allowedTools: ['browser_navigate', 'browser_snapshot'], skipMemory: true, skipContextFiles: true }

    await client.contextEstimate('s-policy', [], undefined, 'default', { executionPolicy })
    await client.chat('s-policy', 'plan only', undefined, undefined, 'default', { executionPolicy })

    expect(request.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      action: 'context_estimate',
      execution_policy: executionPolicy,
    }))
    expect(request.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      action: 'chat',
      execution_policy: executionPolicy,
    }))
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
})

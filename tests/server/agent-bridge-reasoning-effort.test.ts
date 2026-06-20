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
})

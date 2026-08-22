import { describe, expect, it, vi } from 'vitest'

describe('AgentBridgeClient clarify responses', () => {
  it('sends clarify_respond requests to the bridge', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true, resolved: true })

    await expect(client.clarifyRespond('clarify-1', 'Use the first option')).resolves.toEqual({
      ok: true,
      resolved: true,
    })

    expect(request).toHaveBeenCalledWith({
      action: 'clarify_respond',
      clarify_id: 'clarify-1',
      response: 'Use the first option',
    })
  })

  it('sends generation-bound clarify_cancel requests to the bridge', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true, resolved: true })

    await expect(client.clarifyCancel(
      'clarify-1',
      'session-1',
      'run-1',
      'profile-1',
    )).resolves.toEqual({
      ok: true,
      resolved: true,
    })

    expect(request).toHaveBeenCalledWith({
      action: 'clarify_cancel',
      clarify_id: 'clarify-1',
      session_id: 'session-1',
      run_id: 'run-1',
      profile: 'profile-1',
    })
  })
})

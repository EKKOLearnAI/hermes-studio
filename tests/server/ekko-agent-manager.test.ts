import { describe, expect, it, vi } from 'vitest'
import { GlobalEkkoAgent } from '../../packages/server/src/services/ekko-agent/manager'
import type { ModelClient, ModelRequest } from '../../packages/ekko-agent/src'

function modelClient(content: string): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    create: vi.fn(async () => ({ content })),
    stream: vi.fn(),
  }
}

describe('GlobalEkkoAgent', () => {
  it('is created once and handles repeated runs through the same runtime', async () => {
    const agent = new GlobalEkkoAgent()
    const firstClient = modelClient('first')
    const secondClient = modelClient('second')

    const first = await agent.run({ messages: ['hi'], modelClient: firstClient })
    const second = await agent.run({ messages: ['again'], modelClient: secondClient })

    expect(first.output.content).toBe('first')
    expect(second.output.content).toBe('second')
    expect(agent.runCount).toBe(2)
    expect(firstClient.create).toHaveBeenCalledTimes(1)
    expect(secondClient.create).toHaveBeenCalledTimes(1)
  })

  it('passes per-run model defaults, metadata, and tool context', async () => {
    const agent = new GlobalEkkoAgent()
    const client = modelClient('ok')

    await agent.run({
      messages: ['hi'],
      modelClient: client,
      modelDefaults: { model: 'test-model' },
      metadata: { session_id: 'session-1' },
      toolContext: { mcpServers: { test: { command: 'node', enabled: false } } },
    })

    const request = vi.mocked(client.create).mock.calls[0]?.[0] as ModelRequest
    expect(request.model).toBe('test-model')
    expect(request.metadata).toEqual({ session_id: 'session-1' })
  })
})

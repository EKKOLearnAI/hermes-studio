import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGlobalEkkoAgent, GlobalEkkoAgent } from '../../packages/server/src/services/ekko-agent/manager'
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
    const agent = new GlobalEkkoAgent({ memory: false })
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
    const agent = new GlobalEkkoAgent({ memory: false })
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

  it('owns a persistent Ekko database under the configured Web UI home', async () => {
    const webUiHome = await mkdtemp(join(tmpdir(), 'global-ekko-agent-'))
    const agent = new GlobalEkkoAgent({ webUiHome })
    try {
      await agent.run({
        messages: ['hello'],
        modelClient: modelClient('ok'),
        metadata: { session_id: 'session-1' },
      })

      expect(agent.status()).toMatchObject({
        memoryEnabled: true,
        memoryDatabasePath: join(webUiHome, 'ekko', 'ekko.db'),
      })
      expect(existsSync(join(webUiHome, 'ekko', 'ekko.db'))).toBe(true)
    } finally {
      agent.close()
      await rm(webUiHome, { recursive: true, force: true })
    }
  })

  it('does not create a memory database when the production entry is hidden', async () => {
    const webUiHome = await mkdtemp(join(tmpdir(), 'global-ekko-agent-production-'))
    const agent = createGlobalEkkoAgent({ webUiHome }, { NODE_ENV: 'production' })
    try {
      const result = await agent.run({
        messages: ['hello'],
        modelClient: modelClient('ok'),
        metadata: { session_id: 'session-1' },
      })

      expect(result.output.content).toBe('ok')
      expect(agent.status()).toMatchObject({
        memoryEnabled: false,
        memoryDatabasePath: undefined,
      })
      expect(existsSync(join(webUiHome, 'ekko'))).toBe(false)
      expect(existsSync(join(webUiHome, 'ekko', 'ekko.db'))).toBe(false)
    } finally {
      agent.close()
      await rm(webUiHome, { recursive: true, force: true })
    }
  })
})

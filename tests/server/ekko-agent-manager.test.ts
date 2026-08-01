import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalEkkoAgent, GlobalEkkoAgent } from '../../packages/server/src/services/ekko-agent/manager'
import { EkkoFileLogReader } from '../../packages/ekko-agent/src'
import type { ModelClient, ModelRequest } from '../../packages/ekko-agent/src'

const getHermesBaseDirMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getHermesBaseDir: getHermesBaseDirMock,
}))

let baseDirectory = ''

beforeEach(async () => {
  baseDirectory = await mkdtemp(join(tmpdir(), 'global-ekko-agent-'))
  getHermesBaseDirMock.mockReturnValue(join(baseDirectory, 'hermes'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(baseDirectory, { recursive: true, force: true })
})

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
    const agent = new GlobalEkkoAgent({ baseDirectory, memory: false })
    const firstClient = modelClient('first')
    const secondClient = modelClient('second')

    const first = await agent.run({ messages: ['hi'], modelClient: firstClient })
    const second = await agent.run({ messages: ['again'], modelClient: secondClient })

    expect(first.output.content).toBe('first')
    expect(second.output.content).toBe('second')
    expect(agent.runCount).toBe(2)
    expect(firstClient.create).toHaveBeenCalledTimes(1)
    expect(secondClient.create).toHaveBeenCalledTimes(1)
    expect(existsSync(join(baseDirectory, '.ekko', 'skills', 'default'))).toBe(true)
  })

  it('imports Hermes profile skills when the Ekko skills root does not exist', async () => {
    const hermesRoot = join(baseDirectory, 'hermes')
    await mkdir(join(hermesRoot, 'skills', 'default-skill'), { recursive: true })
    await mkdir(join(hermesRoot, 'profiles', 'work', 'skills', 'work-skill'), { recursive: true })
    await writeFile(join(hermesRoot, 'skills', 'default-skill', 'SKILL.md'), '# Default\n')
    await writeFile(join(hermesRoot, 'profiles', 'work', 'skills', 'work-skill', 'SKILL.md'), '# Work\n')

    const agent = new GlobalEkkoAgent({ baseDirectory, memory: false, profile: 'work' })
    try {
      expect(existsSync(join(baseDirectory, '.ekko', 'skills', 'default', 'default-skill', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(baseDirectory, '.ekko', 'skills', 'work', 'work-skill', 'SKILL.md'))).toBe(true)
    } finally {
      agent.close()
    }
  })

  it('estimates context without incrementing the completed run count', async () => {
    const agent = new GlobalEkkoAgent({ baseDirectory, memory: false })
    const client = modelClient('unused')

    const estimate = await agent.estimateContext({
      messages: ['estimate this'],
      modelClient: client,
    })

    expect(estimate.contextTokens).toBeGreaterThan(0)
    expect(agent.runCount).toBe(0)
    expect(client.create).not.toHaveBeenCalled()
  })

  it('passes per-run model defaults, metadata, and tool context', async () => {
    const agent = new GlobalEkkoAgent({ baseDirectory, memory: false })
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
    expect(request.messages[0].content).toContain('## Image and File Output')
    expect(request.messages[0].content).toContain(
      `workspaceRoot: ${join(baseDirectory, '.ekko', 'workspace', 'default', 'session-1')}`,
    )
    expect(request.messages[0].content).toContain('![description](/absolute/path/image.png)')
    expect(request.messages[0].content).toContain('![description](<C:/absolute/path/image.png>)')
    expect(existsSync(join(baseDirectory, '.ekko', 'workspace', 'default', 'session-1'))).toBe(true)
  })

  it('binds skill tools to the directory provided when the agent is created', async () => {
    const agent = new GlobalEkkoAgent({ baseDirectory, memory: false, profile: 'work' })
    const skillDirectory = join(baseDirectory, '.ekko', 'skills', 'work')
    await mkdir(join(skillDirectory, 'demo-skill'), { recursive: true })
    await writeFile(join(skillDirectory, 'demo-skill', 'SKILL.md'), '# Demo\nInstance-bound instructions.\n')
    let call = 0
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(async () => {
        call += 1
        return call === 1
          ? {
              content: '',
              toolCalls: [{ id: 'skill-call', name: 'skill_list', arguments: {} }],
              finishReason: 'tool_calls',
            }
          : { content: 'done' }
      }),
      stream: vi.fn(),
    }
    try {
      const result = await agent.run({ messages: ['find skills'], modelClient: client, toolDelayMs: 0 })

      expect(result.messages.find(message => message.role === 'tool')?.content).toContain('demo-skill')
      expect(agent.status()).toMatchObject({ skillDirectory })
    } finally {
      agent.close()
    }
  })

  it('owns a persistent Ekko database under the configured base directory', async () => {
    const agent = new GlobalEkkoAgent({ baseDirectory })
    try {
      await agent.run({
        messages: ['hello'],
        modelClient: modelClient('ok'),
        metadata: { session_id: 'session-1' },
      })

      expect(agent.status()).toMatchObject({
        memoryEnabled: true,
        memoryDatabasePath: join(baseDirectory, '.ekko', 'ekko.db'),
      })
      expect(existsSync(join(baseDirectory, '.ekko', 'ekko.db'))).toBe(true)
    } finally {
      agent.close()
    }
  })

  it('initializes persistent Ekko memory in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const agent = createGlobalEkkoAgent({ baseDirectory })
    try {
      const result = await agent.run({
        messages: ['hello'],
        modelClient: modelClient('ok'),
        metadata: { session_id: 'session-1' },
      })

      expect(result.output.content).toBe('ok')
      expect(agent.status()).toMatchObject({
        memoryEnabled: true,
        memoryDatabasePath: join(baseDirectory, '.ekko', 'ekko.db'),
        dataDirectory: join(baseDirectory, '.ekko'),
        skillDirectory: join(baseDirectory, '.ekko', 'skills', 'default'),
        logDirectory: join(baseDirectory, '.ekko', 'logs', 'default'),
        workspaceDirectory: join(baseDirectory, '.ekko', 'workspace', 'default'),
        logFilePath: join(baseDirectory, '.ekko', 'logs', 'default', 'ekko-agent.jsonl'),
      })
      expect(existsSync(join(baseDirectory, '.ekko', 'skills'))).toBe(true)
      expect(existsSync(join(baseDirectory, '.ekko', 'workspace'))).toBe(true)
      expect(existsSync(join(baseDirectory, '.ekko', 'logs', 'default', 'ekko-agent.jsonl'))).toBe(true)
      expect(existsSync(join(baseDirectory, '.ekko', 'ekko.db'))).toBe(true)
    } finally {
      agent.close()
    }
  })

  it('lets the runtime own compact model request logs', async () => {
    const agent = new GlobalEkkoAgent({ baseDirectory, memory: false, profile: 'work' })
    try {
      await agent.run({
        messages: ['diagnose this'],
        model: 'test-model',
        modelClient: modelClient('done'),
        logContext: {
          profile: 'work',
          sessionId: 'session-1',
          turnId: 'turn-1',
        },
      })

      const reader = new EkkoFileLogReader({
        directory: join(baseDirectory, '.ekko', 'logs', 'work'),
      })
      expect(reader.query({ sessionId: 'session-1' })).toMatchObject([
        {
          category: 'model',
          event: 'model.request',
          profile: 'work',
          level: 'info',
          sessionId: 'session-1',
          turnId: 'turn-1',
          data: expect.objectContaining({
            status: 'completed',
            provider: 'test',
            model: 'test-model',
            messageCount: 2,
          }),
        },
      ])
      expect('writeLog' in agent).toBe(false)
    } finally {
      agent.close()
    }
  })

  it('injects compact request logging into isolated runtimes', async () => {
    const agent = new GlobalEkkoAgent({ baseDirectory, memory: false, profile: 'work' })
    try {
      await agent.runIsolated(
        {
          modelClient: modelClient('compressed'),
          toolsEnabled: false,
          skillsEnabled: false,
          maxSteps: 1,
          modelDefaults: {
            model: 'summary-model',
          },
        },
        {
          messages: ['compress this history'],
          memoryEnabled: false,
          metadata: {
            purpose: 'context-compression',
            session_id: 'session-1',
          },
          logContext: {
            profile: 'work',
            sessionId: 'session-1',
          },
        },
      )

      const reader = new EkkoFileLogReader({
        directory: join(baseDirectory, '.ekko', 'logs', 'work'),
      })
      expect(reader.query({ sessionId: 'session-1' })).toMatchObject([
        {
          category: 'model',
          event: 'model.request',
          profile: 'work',
          sessionId: 'session-1',
          data: expect.objectContaining({
            status: 'completed',
            purpose: 'context-compression',
            provider: 'test',
            model: 'summary-model',
          }),
        },
      ])
    } finally {
      agent.close()
    }
  })
})

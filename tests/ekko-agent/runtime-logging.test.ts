import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  AgentToolRegistry,
  EKKO_LOG_FILE_NAME,
  EkkoFileLogger,
  EkkoRuntimeLogger,
  MemoryService,
  ModelMemoryExtractor,
  SkillReviewService,
} from '../../packages/ekko-agent/src'
import type { ModelClient, ModelRequest } from '../../packages/ekko-agent/src'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ekko-runtime-logging-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Ekko runtime request logging', () => {
  it('writes one safe terminal record per model-client request attempt and no runtime event records', async () => {
    let calls = 0
    const client: ModelClient = {
      provider: 'test-provider',
      requestStyle: 'openai-chat',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      requestTarget: () => 'https://models.example.test/v1/chat?key=super-secret-key',
      create: vi.fn(async (_request: ModelRequest) => {
        calls += 1
        if (calls === 1) throw new Error('temporary outage')
        return {
          id: 'response-1',
          model: 'served-model',
          content: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        }
      }),
      stream: vi.fn(),
    }
    const logger = new EkkoFileLogger({ directory: root })
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      logWriter: logger,
      logProfile: 'work',
    })

    await runtime.run({
      messages: ['private prompt that must not be logged'],
      model: 'requested-model',
      maxModelRetries: 1,
      logContext: {
        sessionId: 'session-1',
        turnId: 'turn-1',
      },
    })

    const records = logger.query()
    expect(records).toHaveLength(2)
    expect(records.map(record => record.event)).toEqual(['model.request', 'model.request'])
    expect(records[0]).toMatchObject({
      level: 'error',
      profile: 'work',
      sessionId: 'session-1',
      turnId: 'turn-1',
      data: {
        status: 'failed',
        attempt: 1,
        maxAttempts: 2,
        provider: 'test-provider',
        requestStyle: 'openai-chat',
        model: 'requested-model',
        messageCount: 2,
      },
    })
    expect(records[1]).toMatchObject({
      level: 'info',
      data: {
        status: 'completed',
        attempt: 2,
        responseId: 'response-1',
        responseModel: 'served-model',
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      },
    })

    const raw = await readFile(join(root, EKKO_LOG_FILE_NAME), 'utf8')
    expect(raw).not.toContain('private prompt that must not be logged')
    expect(raw).not.toContain('super-secret-key')
    expect(raw).toContain('REDACTED')
    expect(raw).not.toContain('run.started')
    expect(raw).not.toContain('model.started')
  })

  it('uses the same compact request logger for memory and skill-review model calls', async () => {
    const client: ModelClient = {
      provider: 'test-provider',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(async (request: ModelRequest) => ({
        content: request.metadata?.purpose === 'ekko-memory-summary'
          ? JSON.stringify({
              recentTopic: '',
              currentGoal: '',
              constraints: [],
              preferences: [],
              decisions: [],
              completedWork: [],
              pendingWork: [],
              knownIssues: [],
            })
          : 'Nothing to save.',
      })),
      stream: vi.fn(),
    }
    const fileLogger = new EkkoFileLogger({ directory: root })
    const requestLogger = new EkkoRuntimeLogger(fileLogger, { profile: 'default' })
    const memory = new MemoryService({ enabled: false })
    const extractor = new ModelMemoryExtractor({
      modelClient: client,
      memory,
      requestLogger,
      requestRunId: 'parent-run',
      requestLogContext: { sessionId: 'session-1', turnId: 'turn-1' },
    })
    await extractor.extract({
      sessionId: 'session-1',
      messages: [{
        id: 'message-1',
        sessionId: 'session-1',
        role: 'user',
        content: 'remember nothing',
        createdAt: new Date().toISOString(),
      }],
    })

    const skillDirectory = join(root, 'skills')
    await mkdir(skillDirectory, { recursive: true })
    const review = new SkillReviewService({ skillDirectory })
    review.schedule({
      modelClient: client,
      messages: [{ role: 'user', content: 'completed task' }],
      requestLogger,
      requestRunId: 'parent-run',
      requestLogContext: { sessionId: 'session-1', turnId: 'turn-1' },
    })
    await review.drain()
    memory.close()

    const records = fileLogger.query()
    expect(records).toHaveLength(2)
    expect(records.map(record => (record.data as { purpose: string }).purpose)).toEqual([
      'ekko-memory-summary',
      'ekko-skill-review',
    ])
    expect(records.every(record => record.event === 'model.request')).toBe(true)
  })

  it('never lets request diagnostics break model execution', async () => {
    const client: ModelClient = {
      provider: 'test-provider',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: false,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      requestTarget: () => {
        throw new Error('diagnostic target failed')
      },
      create: vi.fn(async () => ({ content: 'still completed' })),
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      logWriter: {
        write() {
          throw new Error('diagnostic sink failed')
        },
      },
    })

    await expect(runtime.run({ messages: ['continue'] })).resolves.toMatchObject({
      output: { content: 'still completed' },
    })
  })

  it('records the empty stream and non-streaming fallback as two real requests', async () => {
    const client: ModelClient = {
      provider: 'stream-provider',
      requestStyle: 'openai-responses',
      capabilities: {
        streaming: true,
        tools: true,
        vision: false,
        jsonMode: true,
        systemPrompt: true,
      },
      create: vi.fn(async () => ({ content: 'fallback result' })),
      stream: vi.fn(async function *stream() {
        yield { type: 'done', response: { finishReason: 'stop' } }
      }),
    }
    const logger = new EkkoFileLogger({ directory: root })
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      logWriter: logger,
    })

    await runtime.run({ messages: ['answer'] })

    expect(logger.query().map(record => record.data)).toMatchObject([
      {
        status: 'completed',
        transport: 'stream',
        emptyResponse: true,
      },
      {
        status: 'completed',
        transport: 'create',
        fallback: true,
      },
    ])
  })
})

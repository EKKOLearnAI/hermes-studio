import { beforeEach, describe, expect, it, vi } from 'vitest'

const exportSessionsRawMock = vi.fn()

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  exportSessionsRaw: exportSessionsRawMock,
}))

describe('conversations service', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T00:00:00Z'))
    exportSessionsRawMock.mockReset()
  })

  it('aggregates a single compression continuation even when the child preview differs', async () => {
    exportSessionsRawMock.mockResolvedValue([
      {
        id: 'root',
        parent_session_id: null,
        source: 'cli',
        model: 'openai/gpt-5.4',
        title: null,
        started_at: 100,
        ended_at: 110,
        end_reason: 'compression',
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 5,
        output_tokens: 8,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0.1,
        actual_cost_usd: 0.1,
        cost_status: 'estimated',
        messages: [
          { id: 1, session_id: 'root', role: 'user', content: 'Start here', timestamp: 101 },
          { id: 2, session_id: 'root', role: 'assistant', content: 'Assistant reply', timestamp: 102 },
        ],
      },
      {
        id: 'root-cont',
        parent_session_id: 'root',
        source: 'cli',
        model: 'openai/gpt-5.4',
        title: 'Continuation',
        started_at: 110,
        ended_at: 111,
        end_reason: null,
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 3,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0.2,
        actual_cost_usd: 0.2,
        cost_status: 'final',
        messages: [
          { id: 3, session_id: 'root-cont', role: 'user', content: 'Continue with more detail', timestamp: 110 },
          { id: 4, session_id: 'root-cont', role: 'assistant', content: 'Continued answer', timestamp: 111 },
        ],
      },
    ])

    const mod = await import('../../packages/server/src/services/hermes/conversations')
    const summaries = await mod.listConversationSummaries({ humanOnly: true })

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        id: 'root',
        thread_session_count: 2,
        ended_at: 111,
        cost_status: 'mixed',
        actual_cost_usd: 0.30000000000000004,
      }),
    )

    const detail = await mod.getConversationDetail('root', { humanOnly: true })
    expect(detail?.thread_session_count).toBe(2)
    expect(detail?.messages.map((message: any) => message.content)).toEqual([
      'Start here',
      'Assistant reply',
      'Continue with more detail',
      'Continued answer',
    ])
  })

  it('treats branched children as their own visible conversations', async () => {
    exportSessionsRawMock.mockResolvedValue([
      {
        id: 'root',
        parent_session_id: null,
        source: 'cli',
        model: 'openai/gpt-5.4',
        title: 'Root',
        started_at: 100,
        ended_at: 200,
        end_reason: 'branched',
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
        messages: [{ id: 1, session_id: 'root', role: 'user', content: 'Root prompt', timestamp: 101 }],
      },
      {
        id: 'branch-child',
        parent_session_id: 'root',
        source: 'cli',
        model: 'openai/gpt-5.4',
        title: 'Branch child',
        started_at: 201,
        ended_at: 210,
        end_reason: null,
        message_count: 2,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
        messages: [
          { id: 2, session_id: 'branch-child', role: 'user', content: 'Branch prompt', timestamp: 202 },
          { id: 3, session_id: 'branch-child', role: 'assistant', content: 'Branch answer', timestamp: 203 },
        ],
      },
    ])

    const mod = await import('../../packages/server/src/services/hermes/conversations')
    const summaries = await mod.listConversationSummaries({ humanOnly: true })

    expect(summaries.map((summary: any) => summary.id)).toEqual(['branch-child', 'root'])

    const detail = await mod.getConversationDetail('branch-child', { humanOnly: true })
    expect(detail?.messages.map((message: any) => message.content)).toEqual(['Branch prompt', 'Branch answer'])
  })

  it('excludes human-only conversations with no visible human messages', async () => {
    exportSessionsRawMock.mockResolvedValue([
      {
        id: 'synthetic-root',
        parent_session_id: null,
        source: 'cli',
        model: 'openai/gpt-5.4',
        title: null,
        started_at: 100,
        ended_at: 101,
        end_reason: null,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
        messages: [
          {
            id: 1,
            session_id: 'synthetic-root',
            role: 'user',
            content: "You've reached the maximum number of tool-calling iterations allowed.",
            timestamp: 100,
          },
        ],
      },
    ])

    const mod = await import('../../packages/server/src/services/hermes/conversations')
    const summaries = await mod.listConversationSummaries({ humanOnly: true })
    const detail = await mod.getConversationDetail('synthetic-root', { humanOnly: true })

    expect(summaries).toEqual([])
    expect(detail).toBeNull()
  })

  it('caches raw exports briefly and normalizes structured message content', async () => {
    exportSessionsRawMock.mockResolvedValue([
      {
        id: 'recent-open',
        parent_session_id: null,
        source: 'cli',
        model: 'openai/gpt-5.4',
        title: 'Recent open',
        started_at: 1776643190,
        ended_at: null,
        end_reason: null,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
        messages: [
          {
            id: 11,
            session_id: 'recent-open',
            role: 'assistant',
            content: [{ text: 'hello' }, { text: 'world' }],
            timestamp: 1776643198,
          },
        ],
      },
      {
        id: 'stale-open',
        parent_session_id: null,
        source: 'cli',
        model: 'openai/gpt-5.4',
        title: 'Stale open',
        started_at: 1776642000,
        ended_at: null,
        end_reason: null,
        message_count: 0,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: 'openai',
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
        cost_status: 'estimated',
        messages: [],
      },
    ])

    const mod = await import('../../packages/server/src/services/hermes/conversations')
    const firstSummaries = await mod.listConversationSummaries({ humanOnly: false })
    const detail = await mod.getConversationDetail('recent-open', { humanOnly: false })
    const secondSummaries = await mod.listConversationSummaries({ humanOnly: false })

    expect(exportSessionsRawMock).toHaveBeenCalledTimes(1)
    expect(firstSummaries.find((summary: any) => summary.id === 'recent-open')?.is_active).toBe(true)
    expect(secondSummaries.find((summary: any) => summary.id === 'stale-open')?.is_active).toBe(false)
    expect(detail?.messages[0].content).toBe('hello\nworld')
  })
})

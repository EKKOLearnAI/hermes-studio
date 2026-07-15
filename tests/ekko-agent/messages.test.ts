import { describe, expect, it } from 'vitest'
import {
  collectModelEvents,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  modelResponseToAgentMessage,
  normalizeAgentMessage,
  normalizeAgentMessages,
} from '../../packages/ekko-agent/src/index'
import type { ModelEvent } from '../../packages/ekko-agent/src/index'

describe('ekko-agent unified messages', () => {
  it('normalizes inbound strings and message-like objects', () => {
    expect(normalizeAgentMessage('hello')).toEqual({
      role: 'user',
      content: 'hello',
    })

    expect(normalizeAgentMessage({
      role: 'assistant',
      text: 'done',
      tool_calls: [{
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'README.md' },
      }],
    })).toEqual({
      role: 'assistant',
      content: 'done',
      name: undefined,
      toolCallId: undefined,
      toolCalls: [{
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'README.md' },
      }],
    })
  })

  it('normalizes message arrays with one internal shape', () => {
    expect(normalizeAgentMessages([
      createSystemMessage('Rules'),
      'Question',
      { role: 'tool', content: { ok: true }, tool_call_id: 'call_1', name: 'lookup' },
    ])).toEqual([
      { role: 'system', content: 'Rules' },
      { role: 'user', content: 'Question' },
      {
        role: 'tool',
        content: '{"ok":true}',
        name: 'lookup',
        toolCallId: 'call_1',
        toolCalls: undefined,
      },
    ])
  })

  it('creates canonical messages', () => {
    expect(createUserMessage('Hi')).toEqual({ role: 'user', content: 'Hi' })
    expect(createAssistantMessage('Done')).toEqual({ role: 'assistant', content: 'Done', toolCalls: undefined })
    expect(createToolResultMessage('call_1', 'result', 'lookup')).toEqual({
      role: 'tool',
      content: 'result',
      toolCallId: 'call_1',
      name: 'lookup',
    })
  })

  it('converts model responses to assistant output messages', () => {
    expect(modelResponseToAgentMessage({
      id: 'res_1',
      model: 'test-model',
      content: 'Hello',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    })).toEqual({
      role: 'assistant',
      id: 'res_1',
      model: 'test-model',
      content: 'Hello',
      toolCalls: undefined,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      raw: undefined,
    })
  })

  it('collects stream events into one assistant output message', async () => {
    async function *events(): AsyncIterable<ModelEvent> {
      yield { type: 'text-delta', text: 'Hel' }
      yield { type: 'reasoning-delta', text: 'thinking ' }
      yield { type: 'reasoning-delta', text: 'step' }
      yield { type: 'text-delta', text: 'lo' }
      yield {
        type: 'tool-call',
        toolCall: {
          id: 'call_1',
          name: 'lookup',
          arguments: { q: 'docs' },
        },
      }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }
      yield { type: 'done', response: { id: 'res_1', model: 'stream-model', finishReason: 'tool_calls' } }
    }

    await expect(collectModelEvents(events())).resolves.toEqual({
      events: [
        { type: 'text-delta', text: 'Hel' },
        { type: 'reasoning-delta', text: 'thinking ' },
        { type: 'reasoning-delta', text: 'step' },
        { type: 'text-delta', text: 'lo' },
        {
          type: 'tool-call',
          toolCall: {
            id: 'call_1',
            name: 'lookup',
            arguments: { q: 'docs' },
          },
        },
        { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
        { type: 'done', response: { id: 'res_1', model: 'stream-model', finishReason: 'tool_calls' } },
      ],
      message: {
        role: 'assistant',
        id: 'res_1',
        model: 'stream-model',
        content: 'Hello',
        reasoning: 'thinking step',
        toolCalls: [{
          id: 'call_1',
          name: 'lookup',
          arguments: { q: 'docs' },
        }],
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        finishReason: 'tool_calls',
        raw: undefined,
      },
    })
  })
})

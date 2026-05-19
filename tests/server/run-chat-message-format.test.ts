import { describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

import {
  convertHistoryFormat,
  handleMessage,
  isAssistantMessageSendable,
} from '../../packages/server/src/services/hermes/run-chat/message-format'
import type { SessionMessage } from '../../packages/server/src/services/hermes/run-chat/types'

describe('run-chat message formatting', () => {
  it('drops empty assistant history messages without tool calls', () => {
    const formatted = convertHistoryFormat([
      { role: 'user', content: 'run a command' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'next turn' },
    ])

    expect(formatted).toEqual([
      { role: 'user', content: 'run a command' },
      { role: 'user', content: 'next turn' },
    ])
  })

  it('converts empty assistant tool-call history messages to non-empty text', () => {
    const toolCalls = [{
      id: 'call_1',
      type: 'function',
      function: { name: 'terminal', arguments: '{}' },
    }]
    const formatted = convertHistoryFormat([
      { role: 'assistant', content: '', tool_calls: toolCalls },
    ])

    expect(formatted).toEqual([
      { role: 'assistant', content: '[Calling tool: terminal with arguments: {}]' },
    ])
  })

  it('drops stale empty assistant messages loaded from the session database', () => {
    const messages: SessionMessage[] = [
      { id: 1, session_id: 's1', role: 'user', content: 'first', timestamp: 1 },
      { id: 2, session_id: 's1', role: 'assistant', content: '', timestamp: 2 },
      { id: 3, session_id: 's1', role: 'assistant', content: 'done', timestamp: 3 },
    ]

    expect(handleMessage(messages, 's1').map(m => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'done' },
    ])
  })

  it('treats assistant tool-call messages as sendable even with empty text', () => {
    expect(isAssistantMessageSendable({
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'terminal', arguments: '{}' },
      }],
    })).toBe(true)
    expect(isAssistantMessageSendable({ content: '' })).toBe(false)
  })
})

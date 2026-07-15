import { describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

import {
  handleMessage,
  isAssistantMessageSendable,
} from '../../packages/server/src/services/hermes/run-chat/message-format'
import type { SessionMessage } from '../../packages/server/src/services/hermes/run-chat/types'

describe('run-chat message formatting', () => {
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

  it('preserves assistant finish reason and run marker when resuming from database messages', () => {
    const messages: SessionMessage[] = [
      {
        id: 1,
        session_id: 's1',
        role: 'assistant',
        content: 'partial answer',
        timestamp: 1,
        finish_reason: null,
        runMarker: 'cli_run_current',
      },
    ]

    expect(handleMessage(messages, 's1')[0]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'partial answer',
      finish_reason: null,
      runMarker: 'cli_run_current',
    }))
  })

  it('preserves persisted MoA display rows when resuming from database messages', () => {
    const messages: SessionMessage[] = [
      {
        id: 1,
        session_id: 's1',
        role: 'moa',
        display_role: 'tool',
        content: JSON.stringify({ preview: '1/2 grok', text: 'reference answer' }),
        timestamp: 1,
        tool_call_id: 'moa:reference:run-1:1',
        tool_name: 'moa_reference',
      },
    ]

    expect(handleMessage(messages, 's1')[0]).toEqual(expect.objectContaining({
      role: 'moa',
      display_role: 'tool',
      content: JSON.stringify({ preview: '1/2 grok', text: 'reference answer' }),
      tool_call_id: 'moa:reference:run-1:1',
      tool_name: 'moa_reference',
    }))
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

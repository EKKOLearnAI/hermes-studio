import { describe, expect, it, vi, beforeEach } from 'vitest'
import { applyResponseStreamEvent, flushResponseRunToDb } from '../../packages/server/src/services/hermes/run-chat/response-stream'
import type { SessionState } from '../../packages/server/src/services/hermes/run-chat/types'

const { addMessageMock } = vi.hoisted(() => ({
  addMessageMock: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  addMessage: addMessageMock,
}))

describe('response stream reasoning storage', () => {
  beforeEach(() => {
    addMessageMock.mockReset()
  })

  it('buffers reasoning without creating an empty assistant message before text arrives', () => {
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }

    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'think first',
    })

    expect(state.messages).toEqual([])

    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_text.delta', {
      delta: 'answer',
    })

    expect(state.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: 'answer',
        reasoning: 'think first',
        reasoning_content: 'think first',
      }),
    ])
  })

  it('keeps reasoning deltas in session memory across tool boundaries', () => {
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }

    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'think before. ',
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_text.delta', {
      delta: 'Before tool.',
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
      item: { type: 'function_call', call_id: 'tool-1', name: 'Bash', arguments: '{}' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'think after. ',
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
      item: { type: 'function_call_output', call_id: 'tool-1', output: 'tool output' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_text.delta', {
      delta: 'After tool.',
    })

    expect(state.messages.map(message => message.role)).toEqual(['assistant', 'assistant', 'tool', 'assistant'])
    expect(state.messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Before tool.',
      reasoning: 'think before. think after. ',
      reasoning_content: 'think before. think after. ',
    })
    expect(state.messages[3]).toMatchObject({
      role: 'assistant',
      content: 'After tool.',
    })
  })

  it('flushes reasoning fields to message storage', () => {
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }

    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'stored thinking',
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_text.delta', {
      delta: 'answer',
    })

    flushResponseRunToDb(state, 'session-1')

    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'session-1',
      role: 'assistant',
      content: 'answer',
      reasoning: 'stored thinking',
      reasoning_content: 'stored thinking',
    }))
  })

  it('deduplicates final reasoning snapshots after streamed reasoning deltas', () => {
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }

    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'Need inspect.',
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.completed', {
      response: {
        id: 'resp-1',
        output: [
          { type: 'reasoning', summary: [{ text: 'Need inspect.' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
        ],
      },
    })

    expect(state.messages[0]).toMatchObject({
      content: 'answer',
      reasoning: 'Need inspect.',
      reasoning_content: 'Need inspect.',
    })
  })
})

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

  it('splits reasoning at tool boundaries and stores the pre-tool segment on the tool call', () => {
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
    const started = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
      item: { type: 'function_call', call_id: 'tool-1', name: 'Bash', arguments: '{}' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'think after. ',
    })
    const completed = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
      item: { type: 'function_call_output', call_id: 'tool-1', output: 'tool output' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_text.delta', {
      delta: 'After tool.',
    })

    expect(state.messages.map(message => message.role)).toEqual(['assistant', 'assistant', 'tool', 'assistant'])
    expect(started?.payload.run_marker).toBe('run-1')
    expect(completed?.payload.run_marker).toBe('run-1')
    expect(state.messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Before tool.',
      reasoning: 'think before. ',
      reasoning_content: 'think before. ',
    })
    expect(state.messages[1]).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning: 'think before. ',
      reasoning_content: 'think before. ',
      tool_calls: [expect.objectContaining({ id: 'tool-1' })],
    })
    expect(state.messages[3]).toMatchObject({
      role: 'assistant',
      content: 'After tool.',
      reasoning: 'think after. ',
      reasoning_content: 'think after. ',
    })
  })

  it('stores a reasoning-only segment on its tool call without duplicating final snapshots', () => {
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }
    const toolCall = { type: 'function_call', call_id: 'tool-1', name: 'Bash', arguments: '{}' }

    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'inspect first',
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.added', {
      item: toolCall,
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
      item: toolCall,
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.completed', {
      response: {
        id: 'resp-1',
        output: [
          { type: 'reasoning', summary: [{ text: 'inspect first' }] },
          toolCall,
        ],
      },
    })

    expect(state.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: '',
        reasoning: 'inspect first',
        reasoning_content: 'inspect first',
        tool_calls: [expect.objectContaining({ id: 'tool-1' })],
      }),
    ])
    expect(state.responseRun?.pendingReasoning).toBeUndefined()
  })

  it('keeps duplicate tool reasoning updates scoped to the current run', () => {
    const previousToolCall = {
      id: 'item_2',
      type: 'function',
      function: { name: 'Command', arguments: '{"command":"pwd"}' },
    }
    const state: SessionState = {
      messages: [{
        id: 1,
        session_id: 'session-1',
        runMarker: 'run-a',
        role: 'assistant',
        content: '',
        reasoning: 'reasoning for run A',
        reasoning_content: 'reasoning for run A',
        tool_calls: [previousToolCall],
        finish_reason: 'tool_calls',
        timestamp: 1,
      }],
      isWorking: false,
      events: [],
      queue: [],
    }
    const repeatedToolCall = {
      type: 'function_call',
      call_id: 'item_2',
      name: 'Command',
      arguments: '{"command":"ls"}',
    }

    applyResponseStreamEvent(state, 'session-1', 'run-b', 'response.created', {
      response: { id: 'resp-b', status: 'in_progress' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-b', 'response.reasoning.delta', {
      delta: 'reasoning for run B',
    })
    applyResponseStreamEvent(state, 'session-1', 'run-b', 'response.output_item.done', {
      item: repeatedToolCall,
    })
    applyResponseStreamEvent(state, 'session-1', 'run-b', 'response.output_item.done', {
      item: repeatedToolCall,
    })

    expect(state.messages[0]).toMatchObject({
      runMarker: 'run-a',
      reasoning: 'reasoning for run A',
      reasoning_content: 'reasoning for run A',
    })
    expect(state.messages[1]).toMatchObject({
      runMarker: 'run-b',
      reasoning: 'reasoning for run B',
      reasoning_content: 'reasoning for run B',
      tool_calls: [expect.objectContaining({ id: 'item_2' })],
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
      run_marker: 'run-1',
      reasoning: 'stored thinking',
      reasoning_content: 'stored thinking',
    }))
  })

  it('rebinds run messages to persisted ids and returns the final assistant id', () => {
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }
    addMessageMock.mockReturnValueOnce(40).mockReturnValueOnce(41).mockReturnValueOnce(42)

    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_text.delta', {
      delta: 'Before tool.',
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
      item: { type: 'function_call', call_id: 'tool-1', name: 'Bash', arguments: '{}' },
    })
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_text.delta', {
      delta: 'Final answer.',
    })
    state.responseRun!.reasoningMessageId = state.messages[2].id

    expect(flushResponseRunToDb(state, 'session-1')).toBe('42')
    expect(state.messages.map(message => message.id)).toEqual([40, 41, 42])
    expect(state.responseRun?.reasoningMessageId).toBe(42)
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

  it('emits only the new suffix when a provider follows reasoning deltas with cumulative snapshots', () => {
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }

    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    const first = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'Need ',
    })
    const cumulative = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'Need inspect.',
    })
    const duplicate = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'Need inspect.',
    })

    expect(first?.payload.delta).toBe('Need ')
    expect(cumulative?.payload.delta).toBe('inspect.')
    expect(duplicate).toBeNull()
    expect(state.responseRun?.pendingReasoning).toBe('Need inspect.')
  })
})

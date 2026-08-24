import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionState } from '../../packages/server/src/services/hermes/run-chat/types'

const { addMessageMock, addMessagesMock } = vi.hoisted(() => ({
  addMessageMock: vi.fn(),
  addMessagesMock: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  addMessage: addMessageMock,
  addMessages: addMessagesMock,
}))

describe('run message persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('atomically gives a completed tool group one run marker in storage and memory', async () => {
    addMessagesMock.mockReturnValue([40, 41])
    const state: SessionState = { messages: [], isWorking: true, events: [], queue: [] }
    const { persistRunMessages } = await import(
      '../../packages/server/src/services/hermes/run-chat/message-persistence'
    )

    const result = persistRunMessages(state, {
      sessionId: 'session-1',
      runMarker: 'run-1',
      appendToState: true,
      atomic: true,
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1' }],
          finish_reason: 'tool_calls',
          reasoning: 'inspect',
          reasoning_content: 'inspect',
        },
        {
          role: 'tool',
          content: 'done',
          display_content: 'Done',
          tool_call_id: 'call-1',
          tool_name: 'terminal',
        },
      ],
    })

    expect(addMessageMock).not.toHaveBeenCalled()
    expect(addMessagesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        role: 'assistant',
        run_marker: 'run-1',
        reasoning: 'inspect',
        reasoning_content: 'inspect',
      }),
      expect.objectContaining({
        role: 'tool',
        run_marker: 'run-1',
        display_content: 'Done',
        tool_call_id: 'call-1',
      }),
    ])
    expect(result.ids).toEqual([40, 41])
    expect(state.messages.map(message => ({ id: message.id, runMarker: message.runMarker }))).toEqual([
      { id: 40, runMarker: 'run-1' },
      { id: 41, runMarker: 'run-1' },
    ])
  })

  it('rebinds an existing streamed message without appending a duplicate', async () => {
    addMessageMock.mockReturnValue(73)
    const message = {
      id: 1,
      session_id: 'session-1',
      runMarker: 'run-stream',
      role: 'assistant',
      content: 'answer',
      timestamp: 1,
    }
    const state: SessionState = {
      messages: [message],
      isWorking: true,
      events: [],
      queue: [],
    }
    const { persistRunMessages } = await import(
      '../../packages/server/src/services/hermes/run-chat/message-persistence'
    )

    persistRunMessages(state, {
      sessionId: 'session-1',
      runMarker: 'run-stream',
      messages: [message],
    })

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].id).toBe(73)
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      run_marker: 'run-stream',
      content: 'answer',
    }))
  })
})

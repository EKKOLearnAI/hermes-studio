import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.fn()
const getSessionDetailMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: addMessageMock,
  getSessionDetail: getSessionDetailMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

describe('Bridge tool result context projection', () => {
  beforeEach(() => {
    addMessageMock.mockReset()
    getSessionDetailMock.mockReset()
  })

  it('keeps the complete result in memory and persistence while context is bounded', async () => {
    addMessageMock.mockReturnValue(77)
    const completeToolResult = `HEAD-${'x'.repeat(70_000)}-TAIL`
    const state: any = {
      messages: [],
      bridgePendingTools: [{
        id: 'tool-call-1',
        name: 'session_get',
        arguments: '{}',
        startedAt: Date.now(),
      }],
    }
    const { recordBridgeToolCompleted } = await import(
      '../../packages/server/src/modules/studio/services/chat-run/bridge-message'
    )
    const { truncateToolResultForContext } = await import(
      '../../packages/server/src/modules/studio/services/chat-run/tool-result-context'
    )

    const completed = recordBridgeToolCompleted(
      state,
      'session-1',
      'run-1',
      'session_get',
      { tool_call_id: 'tool-call-1', result: completeToolResult },
    )

    expect(completed.output).toBe(completeToolResult)
    expect(completed.messageId).toBe(77)
    expect(state.messages[0].content).toBe(completeToolResult)
    expect(state.messages[0].runMarker).toBe('run-1')
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'tool',
      content: completeToolResult,
      run_marker: 'run-1',
    }))
    expect(truncateToolResultForContext(completeToolResult)).toHaveLength(5_500)
  })

  it('bounds Bridge context tokens without changing the default Coding Agent estimate', async () => {
    const completeToolResult = `HEAD-${'x'.repeat(70_000)}-TAIL`
    getSessionDetailMock.mockReturnValue({
      messages: [{ role: 'tool', content: completeToolResult }],
    })
    const { countTokens } = await import('../../packages/server/src/modules/studio/services/context-compressor')
    const { truncateToolResultForContext } = await import(
      '../../packages/server/src/modules/studio/services/chat-run/tool-result-context'
    )
    const { calcAndUpdateUsage } = await import(
      '../../packages/server/src/modules/studio/services/chat-run/usage'
    )
    const makeState = () => ({ messages: [], isWorking: false, events: [], queue: [] }) as any

    const bridgeUsage = await calcAndUpdateUsage(
      'session-1',
      makeState(),
      vi.fn(),
      { truncateToolResultsForContext: true },
    )
    const defaultUsage = await calcAndUpdateUsage('session-1', makeState(), vi.fn())

    expect(bridgeUsage.outputTokens).toBe(countTokens(completeToolResult))
    expect(bridgeUsage.contextOutputTokens).toBe(countTokens(truncateToolResultForContext(completeToolResult)))
    expect(defaultUsage.outputTokens).toBe(countTokens(completeToolResult))
    expect(defaultUsage.contextOutputTokens).toBeUndefined()
    expect(bridgeUsage.outputTokens).toBeGreaterThan(bridgeUsage.contextOutputTokens || 0)
  })
})

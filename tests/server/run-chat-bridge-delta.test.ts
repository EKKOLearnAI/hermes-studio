import { describe, expect, it } from 'vitest'

import { filterBridgeToolCallMarkupDelta, flushPendingToolCallMarkup } from '../../packages/server/src/services/hermes/run-chat/bridge-delta'

describe('run-chat bridge delta filtering', () => {
  it('keeps ordinary assistant text', () => {
    const state = {}

    expect(filterBridgeToolCallMarkupDelta(state, 'hello')).toBe('hello')
    expect(filterBridgeToolCallMarkupDelta(state, ' world')).toBe(' world')
  })

  it('removes complete textual tool-call markup from bridge deltas', () => {
    const state = {}
    const delta = 'Before\n[Calling tool: terminal with arguments: {"cmd":"pwd"}]\nAfter'

    expect(filterBridgeToolCallMarkupDelta(state, delta)).toBe('Before\nAfter')
  })

  it('removes tool-call markup split across multiple chunks', () => {
    const state = {}

    expect(filterBridgeToolCallMarkupDelta(state, '[Calling tool: terminal with arguments: {"cmd"')).toBe('')
    expect(filterBridgeToolCallMarkupDelta(state, ':"pwd"}]\nDone')).toBe('Done')
  })

  it('keeps json arrays and brackets inside tool arguments from leaking', () => {
    const state = {}
    const delta = '[Calling tool: terminal with arguments: {"cmd":"printf \\"[x]\\"","items":["a","b"]}]\nDone'

    expect(filterBridgeToolCallMarkupDelta(state, delta)).toBe('Done')
  })

  it('holds a partial marker suffix until the next chunk', () => {
    const state = {}

    expect(filterBridgeToolCallMarkupDelta(state, 'Text [Call')).toBe('Text ')
    expect(filterBridgeToolCallMarkupDelta(state, 'ing tool: terminal with arguments: {}]\nDone')).toBe('Done')
  })

  it('flushes an orphan partial marker suffix when no text chunk follows', () => {
    const state = {}

    expect(filterBridgeToolCallMarkupDelta(state, 'Text [Call')).toBe('Text ')
    expect(flushPendingToolCallMarkup(state)).toBe('[Call')
    expect(flushPendingToolCallMarkup(state)).toBe('')
  })
})

import { describe, it, expect } from 'vitest'
import { normalizeMobileCalendarRequest as request, normalizeMobileCalendarResponse as response } from '../../packages/server/src/modules/studio/services/chat-run/mobile-calendar'

describe('confirmed mobile deletion contract', () => {
  it.each(['calendar', 'reminder'])('requires exact identity for %s', capability => {
    const base = { capability, action: 'delete', purpose: 'Delete the selected test item' }
    for (const item of [{}, { title: 'test' }, { id: ['1'], title: 'test' }, { id: '1' }]) {
      expect(() => request({ ...base, item })).toThrow()
    }
    const value = request({ ...base, item: { id: '1', title: 'test', start_ms: 1788624000000, due_ms: 1788624000000, deleteAll: true } })
    expect(value.item).not.toHaveProperty('deleteAll')
    expect(response({ status: 'success', result: { item: { id: '1', deleted: true, private: 'hidden' } } }, value))
      .toEqual({ status: 'success', result: { capability, action: 'delete', item: { id: '1', deleted: true } } })
    expect(response({ status: 'success', result: { item: { id: 'other', deleted: true } } }, value)).toBeNull()
    expect(response({ status: 'success', result: {} }, value)).toBeNull()
    expect(response({ status: 'denied' }, value)).toEqual({ status: 'denied' })
  })
  it('does not invent an occurrence for calendar deletion', () => {
    for (const start_ms of [undefined, null, NaN, 'tomorrow']) {
      expect(() => request({ capability: 'calendar', action: 'delete', purpose: 'test', item: { id: '1', title: 'test', start_ms } })).toThrow()
    }
  })
})

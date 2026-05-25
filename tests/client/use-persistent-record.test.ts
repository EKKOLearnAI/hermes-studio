// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { usePersistentRecord } from '@/composables/usePersistentRecord'

describe('usePersistentRecord', () => {
  beforeEach(() => localStorage.clear())

  it('loads saved record and persists updates', () => {
    localStorage.setItem('hermes.sidebar.collapsedGroups', JSON.stringify({ agent: true }))
    const state = usePersistentRecord('hermes.sidebar.collapsedGroups')

    expect(state.record.agent).toBe(true)
    state.record.system = true
    state.persist()

    expect(JSON.parse(localStorage.getItem('hermes.sidebar.collapsedGroups') || '{}')).toEqual({
      agent: true,
      system: true,
    })
  })

  it('ignores invalid stored values', () => {
    localStorage.setItem('hermes.sidebar.collapsedGroups', 'not-json')
    const state = usePersistentRecord('hermes.sidebar.collapsedGroups')

    expect({ ...state.record }).toEqual({})
  })
})

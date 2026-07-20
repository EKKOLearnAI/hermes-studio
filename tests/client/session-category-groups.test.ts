import { describe, expect, it } from 'vitest'

import { buildVisibleSessionCategoryGroups } from '../../packages/client/src/components/hermes/chat/session-category-groups'

describe('session category groups', () => {
  it('hides categories that have no visible sessions', () => {
    const groups = buildVisibleSessionCategoryGroups(
      [
        { id: 1, name: 'Work' },
        { id: 2, name: 'Empty' },
      ],
      [
        { id: 'session-1', categoryId: 1 },
        { id: 'session-2', categoryId: null },
      ],
      'Uncategorized',
    )

    expect(groups.map((group) => [group.key, group.sessions.length])).toEqual([
      ['category-1', 1],
      ['category-none', 1],
    ])
  })

  it('returns no groups when the session list is empty', () => {
    expect(buildVisibleSessionCategoryGroups(
      [{ id: 1, name: 'Work' }],
      [],
      'Uncategorized',
    )).toEqual([])
  })

  it('shows sessions with deleted or unknown categories as uncategorized', () => {
    const groups = buildVisibleSessionCategoryGroups(
      [{ id: 1, name: 'Work' }],
      [{ id: 'session-1', categoryId: 999 }],
      'Uncategorized',
    )

    expect(groups).toEqual([{
      key: 'category-none',
      label: 'Uncategorized',
      sessions: [{ id: 'session-1', categoryId: 999 }],
    }])
  })
})

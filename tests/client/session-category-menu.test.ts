import { describe, expect, it } from 'vitest'
import { buildSessionCategoryMenuChildren, resolveRecentSessionCategoryLabel } from '@/components/hermes/chat/session-category-menu'

describe('session category menu', () => {
  it('disables the current named category without adding a check mark', () => {
    const options = buildSessionCategoryMenuChildren({
      categories: [{ id: 1, name: 'Work' }, { id: 2, name: 'Personal' }],
      currentCategoryId: 1,
      uncategorizedLabel: 'Uncategorized',
      loadFailedLabel: 'Failed to load categories',
      retryLabel: 'Retry',
      loadFailed: false,
      loading: false,
    })

    expect(options).toEqual([
      { label: 'Uncategorized', key: 'category:none', disabled: false },
      { label: 'Work', key: 'category:1', disabled: true },
      { label: 'Personal', key: 'category:2', disabled: false },
    ])
  })

  it('disables uncategorized for an uncategorized session', () => {
    const options = buildSessionCategoryMenuChildren({
      categories: [{ id: 1, name: 'Work' }],
      currentCategoryId: null,
      uncategorizedLabel: 'Uncategorized',
      loadFailedLabel: 'Failed to load categories',
      retryLabel: 'Retry',
      loadFailed: false,
      loading: false,
    })

    expect(options[0]).toEqual({
      label: 'Uncategorized',
      key: 'category:none',
      disabled: true,
    })
  })

  it('shows an explicit failure and retry action instead of an empty category menu', () => {
    expect(buildSessionCategoryMenuChildren({
      categories: [],
      currentCategoryId: null,
      uncategorizedLabel: 'Uncategorized',
      loadFailedLabel: 'Failed to load categories',
      retryLabel: 'Retry',
      loadFailed: true,
      loading: false,
    })).toEqual([
      { label: 'Failed to load categories', key: 'category:load-failed', disabled: true },
      { label: 'Retry', key: 'category:retry', disabled: false },
    ])
  })
})


describe('recent session category label', () => {
  const categories = new Map([[1, 'Work']])

  it('shows the localized uncategorized label only after categories load successfully', () => {
    expect(resolveRecentSessionCategoryLabel(null, categories, true, false, 'Uncategorized')).toBe('Uncategorized')
    expect(resolveRecentSessionCategoryLabel(null, categories, false, false, 'Uncategorized')).toBeUndefined()
    expect(resolveRecentSessionCategoryLabel(null, categories, true, true, 'Uncategorized')).toBeUndefined()
  })

  it('keeps named labels and does not invent a label for unresolved category ids', () => {
    expect(resolveRecentSessionCategoryLabel(1, categories, true, false, 'Uncategorized')).toBe('Work')
    expect(resolveRecentSessionCategoryLabel(2, categories, true, false, 'Uncategorized')).toBeUndefined()
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'hermes.models.collapsedProviderGroups'

/**
 * The model pickers used to forget every collapsed provider the moment they
 * closed. These cover what is remembered, what is deliberately not stored, and
 * that two pickers open at once share one record instead of overwriting it.
 */
describe('collapsed provider groups', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  async function load() {
    return import('../../packages/client/src/composables/useCollapsedProviderGroups')
  }

  it('remembers a collapsed group across a reload', async () => {
    const { useCollapsedProviderGroups } = await load()
    useCollapsedProviderGroups().toggleGroup('nvidia')

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')).toEqual({ nvidia: true })

    // A reload is a fresh module with the same storage behind it.
    vi.resetModules()
    const reloaded = await load()
    expect(reloaded.useCollapsedProviderGroups().isGroupCollapsed('nvidia')).toBe(true)
  })

  it('drops a group from storage when it is expanded again', async () => {
    const { useCollapsedProviderGroups } = await load()
    const picker = useCollapsedProviderGroups()

    picker.toggleGroup('xiaomi')
    picker.toggleGroup('xiaomi')

    expect(picker.isGroupCollapsed('xiaomi')).toBe(false)
    // Expanded is the default, so it is stored as absence rather than as false.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')).toEqual({})
  })

  it('keeps groups collapsed by other pickers instead of overwriting them', async () => {
    const { useCollapsedProviderGroups } = await load()
    const sessionModelDialog = useCollapsedProviderGroups()
    const workflowPicker = useCollapsedProviderGroups()

    sessionModelDialog.toggleGroup('nvidia')
    workflowPicker.toggleGroup('openai')

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')).toEqual({ nvidia: true, openai: true })
    expect(sessionModelDialog.isGroupCollapsed('openai')).toBe(true)
    expect(workflowPicker.isGroupCollapsed('nvidia')).toBe(true)
  })

  it('starts clean when storage holds something that is not a record', async () => {
    localStorage.setItem(STORAGE_KEY, 'not json')
    const { useCollapsedProviderGroups } = await load()

    expect(useCollapsedProviderGroups().isGroupCollapsed('nvidia')).toBe(false)
  })
})

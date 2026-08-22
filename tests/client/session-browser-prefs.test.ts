// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'

describe('session browser prefs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
  })

  it('persists pins per profile and prunes missing sessions', () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'

    const store = useSessionBrowserPrefsStore()
    expect(store.pinnedIds).toEqual([])

    store.togglePinned('session-1')
    store.togglePinned('session-2')
    expect(store.pinnedIds).toEqual(['session-1', 'session-2'])
    expect(JSON.parse(window.localStorage.getItem('hermes_session_pins_v1_default') || '[]')).toEqual(['session-1', 'session-2'])

    expect(store.pruneMissingSessions(['session-2'])).toBe(true)
    expect(store.pinnedIds).toEqual(['session-2'])
    expect(JSON.parse(window.localStorage.getItem('hermes_session_pins_v1_default') || '[]')).toEqual(['session-2'])
  })

  it('does not erase saved pins when the current session list is transiently empty', () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'
    const store = useSessionBrowserPrefsStore()

    store.togglePinned('session-1')
    expect(store.pruneMissingSessions([])).toBe(false)
    expect(store.pinnedIds).toEqual(['session-1'])
    expect(JSON.parse(window.localStorage.getItem('hermes_session_pins_v1_default') || '[]')).toEqual(['session-1'])
  })

  it('persists whether the recent group is collapsed', () => {
    const store = useSessionBrowserPrefsStore()

    expect(store.recentCollapsed).toBe(false)

    store.setRecentCollapsed(true)

    expect(store.recentCollapsed).toBe(true)
    expect(window.localStorage.getItem('hermes_recent_sessions_collapsed_v1')).toBe('true')

    setActivePinia(createPinia())
    expect(useSessionBrowserPrefsStore().recentCollapsed).toBe(true)
  })

  it('persists recent visibility without changing the saved recent count', () => {
    const store = useSessionBrowserPrefsStore()

    expect(store.showRecentSessions).toBe(true)
    store.setRecentCount(24)
    store.setShowRecentSessions(false)

    expect(store.showRecentSessions).toBe(false)
    expect(store.recentCount).toBe(24)
    expect(window.localStorage.getItem('hermes_show_recent_sessions_v1')).toBe('false')
    expect(window.localStorage.getItem('hermes_recent_session_count_v1')).toBe('24')

    setActivePinia(createPinia())
    const restoredStore = useSessionBrowserPrefsStore()
    expect(restoredStore.showRecentSessions).toBe(false)
    expect(restoredStore.recentCount).toBe(24)

    restoredStore.setShowRecentSessions(true)
    expect(restoredStore.recentCount).toBe(24)
  })

  it('reloads pin and human-only preferences automatically when the active profile changes', async () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'
    const store = useSessionBrowserPrefsStore()

    expect(store.humanOnly).toBe(true)
    store.togglePinned('default-session')
    store.setHumanOnly(false)

    window.localStorage.setItem('hermes_session_pins_v1_work', JSON.stringify(['work-session']))
    window.localStorage.setItem('hermes_human_only_v1_work', JSON.stringify(true))

    profilesStore.activeProfileName = 'work'
    await nextTick()

    expect(store.profileName).toBe('work')
    expect(store.pinnedIds).toEqual(['work-session'])
    expect(store.humanOnly).toBe(true)

    profilesStore.activeProfileName = 'default'
    await nextTick()

    expect(store.pinnedIds).toEqual(['default-session'])
    expect(store.humanOnly).toBe(false)
  })
})

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { setApiKey } from '@/api/client'

const pinApi = vi.hoisted(() => ({
  fetch: vi.fn(async () => ({ pinnedIds: [] as string[] })),
  merge: vi.fn(async (_profile: string, pinnedIds: string[]) => ({ pinnedIds })),
  set: vi.fn(async (_profile?: string, _sessionId?: string, _pinned?: boolean, _mergePinnedIds?: string[]) => ({ pinnedIds: [] as string[] })),
}))

vi.mock('@/api/studio/sessions', () => ({
  fetchSessionPins: pinApi.fetch,
  mergeSessionPins: pinApi.merge,
  setSessionPinned: pinApi.set,
}))

import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'

describe('session browser prefs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
    pinApi.fetch.mockClear()
    pinApi.merge.mockClear()
    pinApi.set.mockClear()
    pinApi.fetch.mockResolvedValue({ pinnedIds: [] })
    pinApi.merge.mockImplementation(async (_profile, pinnedIds) => ({ pinnedIds }))
    pinApi.set.mockImplementation(async (_profile, sessionId, pinned, mergePinnedIds = []) => ({
      pinnedIds: pinned && sessionId
        ? [...new Set([...mergePinnedIds, sessionId])]
        : mergePinnedIds.filter(id => id !== sessionId),
    }))
  })

  it('persists pins per profile and prunes missing sessions', () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'

    const store = useSessionBrowserPrefsStore()
    expect(store.pinnedIds).toEqual([])

    store.togglePinned('session-1')
    store.togglePinned('session-2')
    expect(store.pinnedIds).toEqual(['session-1', 'session-2'])
    expect(JSON.parse(window.localStorage.getItem('hermes_session_pins_v1_anonymous_default') || '[]')).toEqual(['session-1', 'session-2'])

    expect(store.pruneMissingSessions(['session-2'])).toBe(true)
    expect(store.pinnedIds).toEqual(['session-2'])
    expect(JSON.parse(window.localStorage.getItem('hermes_session_pins_v1_anonymous_default') || '[]')).toEqual(['session-2'])
  })

  it('does not erase saved pins when the current session list is transiently empty', () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'
    const store = useSessionBrowserPrefsStore()

    store.togglePinned('session-1')
    expect(store.pruneMissingSessions([])).toBe(false)
    expect(store.pinnedIds).toEqual(['session-1'])
    expect(JSON.parse(window.localStorage.getItem('hermes_session_pins_v1_anonymous_default') || '[]')).toEqual(['session-1'])
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

    window.localStorage.setItem('hermes_session_pins_v1_anonymous_work', JSON.stringify(['work-session']))
    window.localStorage.setItem('hermes_human_only_v1_work', JSON.stringify(true))

    profilesStore.activeProfileName = 'work'
    await nextTick()

    expect(store.profileName).toBe('work')
    expect(store.pinnedIds).toEqual(['work-session'])
    expect(store.humanOnly).toBe(true)

    pinApi.fetch.mockResolvedValue({ pinnedIds: ['default-session'] })
    profilesStore.activeProfileName = 'default'
    await nextTick()

    expect(store.pinnedIds).toEqual(['default-session'])
    expect(store.humanOnly).toBe(false)
  })

  it('merges legacy local pins once and adopts the server result on a new device', async () => {
    window.localStorage.setItem('hermes_session_pins_v1_default', JSON.stringify(['desktop-pin']))
    pinApi.merge.mockResolvedValue({ pinnedIds: ['mobile-pin', 'desktop-pin'] })

    const store = useSessionBrowserPrefsStore()
    await store.syncPins()

    expect(pinApi.merge).toHaveBeenCalledWith('default', ['desktop-pin'])
    expect(store.pinnedIds).toEqual(['mobile-pin', 'desktop-pin'])
    expect(window.localStorage.getItem('hermes_session_pins_migrated_v2_anonymous_default')).toBe('true')
  })

  it('loads server pins instead of stale local pins after migration', async () => {
    window.localStorage.setItem('hermes_session_pins_v1_anonymous_default', JSON.stringify(['stale-local']))
    window.localStorage.setItem('hermes_session_pins_migrated_v2_anonymous_default', 'true')
    pinApi.fetch.mockResolvedValue({ pinnedIds: ['remote-pin'] })

    const store = useSessionBrowserPrefsStore()
    await store.syncPins()

    expect(pinApi.merge).not.toHaveBeenCalled()
    expect(pinApi.fetch).toHaveBeenCalledWith('default')
    expect(store.pinnedIds).toEqual(['remote-pin'])
  })

  it('does not carry one signed-in user pin cache into another account', async () => {
    const jwt = (sub: number) => `x.${btoa(JSON.stringify({ sub }))}.x`
    setApiKey(jwt(1))
    window.localStorage.setItem('hermes_session_pins_v1_1_default', JSON.stringify(['user-one-pin']))
    const store = useSessionBrowserPrefsStore()
    expect(store.pinnedIds).toEqual(['user-one-pin'])

    setApiKey(jwt(2))
    pinApi.merge.mockResolvedValue({ pinnedIds: ['user-two-pin'] })
    await store.syncPins()

    expect(pinApi.merge).toHaveBeenCalledWith('default', [])
    expect(store.pinnedIds).toEqual(['user-two-pin'])
  })

  it('migrates all legacy pins before the first toggle writes shared state', async () => {
    window.localStorage.setItem('hermes_session_pins_v1_default', JSON.stringify(['legacy-pin']))
    pinApi.set.mockResolvedValue({ pinnedIds: ['legacy-pin', 'new-pin'] })
    const store = useSessionBrowserPrefsStore()

    await store.togglePinned('new-pin')

    expect(pinApi.merge).not.toHaveBeenCalled()
    expect(pinApi.set).toHaveBeenCalledWith('default', 'new-pin', true, ['legacy-pin', 'new-pin'])
    expect(window.localStorage.getItem('hermes_session_pins_migrated_v2_anonymous_default')).toBe('true')
  })

  it('rolls back an optimistic pin when the shared write fails', async () => {
    window.localStorage.setItem('hermes_session_pins_migrated_v2_anonymous_default', 'true')
    pinApi.set.mockRejectedValue(new Error('offline'))
    const store = useSessionBrowserPrefsStore()

    await expect(store.togglePinned('failed-pin')).resolves.toBe(false)

    expect(store.pinnedIds).toEqual([])
    expect(JSON.parse(window.localStorage.getItem('hermes_session_pins_v1_anonymous_default') || '[]')).toEqual([])
  })

  it('rolls back an automatic unpin when the shared write fails', async () => {
    window.localStorage.setItem('hermes_session_pins_v1_anonymous_default', JSON.stringify(['pinned-session']))
    window.localStorage.setItem('hermes_session_pins_migrated_v2_anonymous_default', 'true')
    pinApi.set.mockRejectedValue(new Error('offline'))
    const store = useSessionBrowserPrefsStore()

    await expect(store.removePinned('pinned-session')).resolves.toBe(false)

    expect(store.pinnedIds).toEqual(['pinned-session'])
    expect(JSON.parse(window.localStorage.getItem('hermes_session_pins_v1_anonymous_default') || '[]')).toEqual(['pinned-session'])
  })

  it('rolls back each failed automatic unpin when removals overlap', async () => {
    window.localStorage.setItem('hermes_session_pins_v1_anonymous_default', JSON.stringify(['pin-a', 'pin-b']))
    window.localStorage.setItem('hermes_session_pins_migrated_v2_anonymous_default', 'true')
    pinApi.set.mockRejectedValue(new Error('offline'))
    const store = useSessionBrowserPrefsStore()

    await expect(Promise.all([
      store.removePinned('pin-a'),
      store.removePinned('pin-b'),
    ])).resolves.toEqual([false, false])

    expect(store.pinnedIds).toEqual(['pin-a', 'pin-b'])
    expect(JSON.parse(window.localStorage.getItem('hermes_session_pins_v1_anonymous_default') || '[]')).toEqual(['pin-a', 'pin-b'])
  })

  it('removes a deleted session pin from its own profile', async () => {
    window.localStorage.setItem('hermes_session_pins_v1_anonymous_work', JSON.stringify(['work-session']))
    window.localStorage.setItem('hermes_session_pins_migrated_v2_anonymous_work', 'true')
    pinApi.set.mockResolvedValue({ pinnedIds: [] })
    const store = useSessionBrowserPrefsStore()

    await expect(store.removePinned('work-session', 'work')).resolves.toBe(true)

    expect(pinApi.set).toHaveBeenCalledWith('work', 'work-session', false, undefined)
    expect(store.pinnedIds).toEqual([])
    expect(JSON.parse(window.localStorage.getItem('hermes_session_pins_v1_anonymous_work') || '[]')).toEqual([])
  })

  it('orders an automatic unpin before a newer repin', async () => {
    window.localStorage.setItem('hermes_session_pins_v1_anonymous_default', JSON.stringify(['pinned-session']))
    window.localStorage.setItem('hermes_session_pins_migrated_v2_anonymous_default', 'true')
    let resolveUnpin!: (value: { pinnedIds: string[] }) => void
    pinApi.set
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveUnpin = resolve
      }))
      .mockResolvedValueOnce({ pinnedIds: ['pinned-session'] })
    const store = useSessionBrowserPrefsStore()

    const unpin = store.removePinned('pinned-session')
    const repin = store.togglePinned('pinned-session')
    await Promise.resolve()
    expect(pinApi.set).toHaveBeenCalledTimes(1)

    resolveUnpin({ pinnedIds: [] })
    await expect(unpin).resolves.toBe(true)
    await expect(repin).resolves.toBe(true)

    expect(pinApi.set.mock.calls.map(call => [call[1], call[2]])).toEqual([
      ['pinned-session', false],
      ['pinned-session', true],
    ])
    expect(store.pinnedIds).toEqual(['pinned-session'])
  })

  it('writes pin toggles to the shared server preference', async () => {
    window.localStorage.setItem('hermes_session_pins_migrated_v2_anonymous_default', 'true')
    pinApi.set.mockResolvedValue({ pinnedIds: ['shared-session'] })
    const store = useSessionBrowserPrefsStore()

    await store.togglePinned('shared-session')

    expect(pinApi.set).toHaveBeenCalledWith('default', 'shared-session', true, undefined)
    expect(store.pinnedIds).toEqual(['shared-session'])
  })
})

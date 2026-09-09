import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getStoredUserId } from '@/api/client'
import { fetchSessionPins, mergeSessionPins, setSessionPinned } from '@/api/studio/sessions'
import { useProfilesStore } from './profiles'

const PIN_KEY_PREFIX = 'hermes_session_pins_v1_'
const PIN_MIGRATION_KEY_PREFIX = 'hermes_session_pins_migrated_v2_'
const HUMAN_ONLY_KEY_PREFIX = 'hermes_human_only_v1_'
const RECENT_COUNT_KEY = 'hermes_recent_session_count_v1'
const RECENT_COLLAPSED_KEY = 'hermes_recent_sessions_collapsed_v1'
const SHOW_RECENT_SESSIONS_KEY = 'hermes_show_recent_sessions_v1'

function currentProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || 'default'
  } catch {
    // Fallback during store initialization
    return localStorage.getItem('hermes_active_profile_name') || 'default'
  }
}

function currentPinOwner(): string {
  return String(getStoredUserId() ?? 'anonymous')
}

function pinsKey(profileName: string, owner = currentPinOwner()): string {
  return `${PIN_KEY_PREFIX}${owner}_${profileName}`
}

function legacyPinsKey(profileName: string): string {
  return `${PIN_KEY_PREFIX}${profileName}`
}

function humanOnlyKey(profileName: string): string {
  return `${HUMAN_ONLY_KEY_PREFIX}${profileName}`
}

function pinMigrationKey(profileName: string, owner = currentPinOwner()): string {
  return `${PIN_MIGRATION_KEY_PREFIX}${owner}_${profileName}`
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota/storage errors — fall back to in-memory only
  }
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export const useSessionBrowserPrefsStore = defineStore('session-browser-prefs', () => {
  const profileName = ref(currentProfileName())
  let pinOwner = currentPinOwner()
  const pinnedIds = ref<string[]>(loadJson<string[]>(pinsKey(profileName.value, pinOwner), []))
  const humanOnly = ref<boolean>(loadJson<boolean>(humanOnlyKey(profileName.value), true))
  const recentCount = ref<number>(Math.min(100, Math.max(1, loadJson<number>(RECENT_COUNT_KEY, 10))))
  const recentCollapsed = ref<boolean>(loadJson<boolean>(RECENT_COLLAPSED_KEY, false))
  const showRecentSessions = ref<boolean>(loadJson<boolean>(SHOW_RECENT_SESSIONS_KEY, true))
  let pinMutationVersion = 0
  let nextPinMutationId = 0
  const pinMutationIds = new Map<string, number>()
  const pinWriteQueues = new Map<string, Promise<void>>()

  function pinContextKey(profile: string, owner: string): string {
    return `${owner}\u0000${profile}`
  }

  function pinMutationKey(profile: string, owner: string, sessionId: string): string {
    return `${pinContextKey(profile, owner)}\u0000${sessionId}`
  }

  async function runPinWrite<T>(profile: string, owner: string, write: () => Promise<T>): Promise<T> {
    const key = pinContextKey(profile, owner)
    const previous = pinWriteQueues.get(key) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.then(() => current)
    pinWriteQueues.set(key, tail)
    await previous
    try {
      return await write()
    } finally {
      release()
      if (pinWriteQueues.get(key) === tail) pinWriteQueues.delete(key)
    }
  }

  function setCachedPinned(profile: string, owner: string, sessionId: string, pinned: boolean): void {
    const active = profileName.value === profile && pinOwner === owner
    const current = active
      ? pinnedIds.value
      : loadJson<string[]>(pinsKey(profile, owner), [])
    const hasPin = current.includes(sessionId)
    if (hasPin === pinned) return
    const next = pinned
      ? [...current, sessionId]
      : current.filter(id => id !== sessionId)
    if (active) pinnedIds.value = next
    saveJson(pinsKey(profile, owner), next)
  }

  function reloadPinOwner(): void {
    const nextOwner = currentPinOwner()
    if (nextOwner === pinOwner) return
    pinOwner = nextOwner
    pinnedIds.value = loadJson<string[]>(pinsKey(profileName.value, pinOwner), [])
    ++pinMutationVersion
  }

  function reload() {
    reloadPinOwner()
    profileName.value = currentProfileName()
    pinnedIds.value = loadJson<string[]>(pinsKey(profileName.value, pinOwner), [])
    humanOnly.value = loadJson<boolean>(humanOnlyKey(profileName.value), true)
  }

  function persistPins() {
    saveJson(pinsKey(profileName.value, pinOwner), pinnedIds.value)
  }

  function persistHumanOnly() {
    saveJson(humanOnlyKey(profileName.value), humanOnly.value)
  }

  function isPinned(sessionId: string): boolean {
    return pinnedIds.value.includes(sessionId)
  }

  async function syncPins(): Promise<void> {
    reloadPinOwner()
    const profile = profileName.value
    const owner = pinOwner
    const version = ++pinMutationVersion
    const localPinnedIds = [...pinnedIds.value]
    try {
      const migrated = localStorage.getItem(pinMigrationKey(profile, owner)) === 'true'
      const result = await runPinWrite(profile, owner, () => migrated
        ? fetchSessionPins(profile)
        : mergeSessionPins(profile, [
            ...loadJson<string[]>(legacyPinsKey(profile), []),
            ...localPinnedIds,
          ]))
      if (profileName.value !== profile || pinOwner !== owner || version !== pinMutationVersion) return
      pinnedIds.value = result.pinnedIds
      persistPins()
      if (!migrated) {
        localStorage.setItem(pinMigrationKey(profile, owner), 'true')
        localStorage.removeItem(legacyPinsKey(profile))
      }
    } catch {
      // Keep the local cache while offline; a later reload retries the sync.
    }
  }

  async function togglePinned(sessionId: string): Promise<boolean> {
    reloadPinOwner()
    const profile = profileName.value
    const owner = pinOwner
    const previous = [...pinnedIds.value]
    if (isPinned(sessionId)) {
      pinnedIds.value = pinnedIds.value.filter(id => id !== sessionId)
    } else {
      pinnedIds.value = [...pinnedIds.value, sessionId]
    }
    persistPins()

    const pinned = pinnedIds.value.includes(sessionId)
    const version = ++pinMutationVersion
    const mutationKey = pinMutationKey(profile, owner, sessionId)
    const mutationId = ++nextPinMutationId
    pinMutationIds.set(mutationKey, mutationId)
    try {
      const mergePinnedIds = localStorage.getItem(pinMigrationKey(profile, owner)) === 'true'
        ? undefined
        : [
            ...loadJson<string[]>(legacyPinsKey(profile), []),
            ...pinnedIds.value,
          ]
      const result = await runPinWrite(
        profile,
        owner,
        () => setSessionPinned(profile, sessionId, pinned, mergePinnedIds),
      )
      if (profileName.value === profile && pinOwner === owner && version === pinMutationVersion) {
        pinnedIds.value = result.pinnedIds
        persistPins()
      }
      localStorage.setItem(pinMigrationKey(profile, owner), 'true')
      localStorage.removeItem(legacyPinsKey(profile))
      return true
    } catch {
      if (pinMutationIds.get(mutationKey) === mutationId) {
        setCachedPinned(profile, owner, sessionId, previous.includes(sessionId))
      }
      return false
    } finally {
      if (pinMutationIds.get(mutationKey) === mutationId) pinMutationIds.delete(mutationKey)
    }
  }

  async function removePinned(sessionId: string, sessionProfile?: string | null): Promise<boolean> {
    reloadPinOwner()
    const profile = sessionProfile || profileName.value
    const owner = pinOwner
    const active = profile === profileName.value
    const previous = active
      ? [...pinnedIds.value]
      : loadJson<string[]>(pinsKey(profile, owner), [])
    if (active && !previous.includes(sessionId)) return false
    setCachedPinned(profile, owner, sessionId, false)
    const version = active ? ++pinMutationVersion : pinMutationVersion
    const mutationKey = pinMutationKey(profile, owner, sessionId)
    const mutationId = ++nextPinMutationId
    pinMutationIds.set(mutationKey, mutationId)
    try {
      const mergePinnedIds = localStorage.getItem(pinMigrationKey(profile, owner)) === 'true'
        ? undefined
        : [
            ...loadJson<string[]>(legacyPinsKey(profile), []),
            ...previous.filter(id => id !== sessionId),
          ]
      const result = await runPinWrite(
        profile,
        owner,
        () => setSessionPinned(profile, sessionId, false, mergePinnedIds),
      )
      if (active && profileName.value === profile && pinOwner === owner && version === pinMutationVersion) {
        pinnedIds.value = result.pinnedIds
        persistPins()
      } else if (!active) {
        saveJson(pinsKey(profile, owner), result.pinnedIds)
      }
      localStorage.setItem(pinMigrationKey(profile, owner), 'true')
      localStorage.removeItem(legacyPinsKey(profile))
      return true
    } catch {
      if (pinMutationIds.get(mutationKey) === mutationId) {
        setCachedPinned(profile, owner, sessionId, previous.includes(sessionId))
      }
      return false
    } finally {
      if (pinMutationIds.get(mutationKey) === mutationId) pinMutationIds.delete(mutationKey)
    }
  }

  function setHumanOnly(value: boolean) {
    if (humanOnly.value === value) return
    humanOnly.value = value
    persistHumanOnly()
  }

  function setRecentCount(value: number) {
    recentCount.value = Math.min(100, Math.max(1, Math.floor(Number(value) || 10)))
    saveJson(RECENT_COUNT_KEY, recentCount.value)
  }

  function setRecentCollapsed(value: boolean) {
    recentCollapsed.value = value
    saveJson(RECENT_COLLAPSED_KEY, value)
  }

  function setShowRecentSessions(value: boolean) {
    showRecentSessions.value = value
    saveJson(SHOW_RECENT_SESSIONS_KEY, value)
  }

  function pruneMissingSessions(existingIds: string[]): boolean {
    if (existingIds.length === 0) return false
    const existing = new Set(existingIds)
    const nextPinnedIds = pinnedIds.value.filter(id => existing.has(id))
    if (sameIds(nextPinnedIds, pinnedIds.value)) return false
    pinnedIds.value = nextPinnedIds
    persistPins()
    return true
  }

  watch(
    () => useProfilesStore().activeProfileName,
    () => reload(),
  )

  return {
    profileName,
    pinnedIds,
    humanOnly,
    recentCount,
    recentCollapsed,
    showRecentSessions,
    reload,
    syncPins,
    isPinned,
    togglePinned,
    removePinned,
    setHumanOnly,
    setRecentCount,
    setRecentCollapsed,
    setShowRecentSessions,
    pruneMissingSessions,
  }
})

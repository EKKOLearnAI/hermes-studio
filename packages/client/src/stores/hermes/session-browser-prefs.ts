import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useProfilesStore } from './profiles'

const PIN_KEY_PREFIX = 'hermes_session_pins_v1_'
const HUMAN_ONLY_KEY_PREFIX = 'hermes_human_only_v1_'

function currentProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || localStorage.getItem('hermes_active_profile_name') || 'default'
  } catch {
    return localStorage.getItem('hermes_active_profile_name') || 'default'
  }
}

function pinsKey(profileName: string): string {
  return `${PIN_KEY_PREFIX}${profileName}`
}

function humanOnlyKey(profileName: string): string {
  return `${HUMAN_ONLY_KEY_PREFIX}${profileName}`
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
  const pinnedIds = ref<string[]>(loadJson<string[]>(pinsKey(profileName.value), []))
  const humanOnly = ref<boolean>(loadJson<boolean>(humanOnlyKey(profileName.value), true))

  function reload() {
    profileName.value = currentProfileName()
    pinnedIds.value = loadJson<string[]>(pinsKey(profileName.value), [])
    humanOnly.value = loadJson<boolean>(humanOnlyKey(profileName.value), true)
  }

  function persistPins() {
    saveJson(pinsKey(profileName.value), pinnedIds.value)
  }

  function persistHumanOnly() {
    saveJson(humanOnlyKey(profileName.value), humanOnly.value)
  }

  function isPinned(sessionId: string): boolean {
    return pinnedIds.value.includes(sessionId)
  }

  function togglePinned(sessionId: string) {
    if (isPinned(sessionId)) {
      pinnedIds.value = pinnedIds.value.filter(id => id !== sessionId)
    } else {
      pinnedIds.value = [...pinnedIds.value, sessionId]
    }
    persistPins()
  }

  function removePinned(sessionId: string): boolean {
    if (!isPinned(sessionId)) return false
    pinnedIds.value = pinnedIds.value.filter(id => id !== sessionId)
    persistPins()
    return true
  }

  function setHumanOnly(value: boolean) {
    if (humanOnly.value === value) return
    humanOnly.value = value
    persistHumanOnly()
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
    reload,
    isPinned,
    togglePinned,
    removePinned,
    setHumanOnly,
    pruneMissingSessions,
  }
})

import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as profilesApi from '@/api/hermes/profiles'
import type { HermesProfile, HermesProfileDetail } from '@/api/hermes/profiles'

const ACTIVE_PROFILE_STORAGE_KEY = 'hermes_active_profile_name'

export const useProfilesStore = defineStore('profiles', () => {
  const profiles = ref<HermesProfile[]>([])
  // 初始化时同步读 localStorage，确保其他 store（如 chat）在启动时能拿到 profile name
  const activeProfileName = ref<string | null>(localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY))
  const activeProfile = ref<HermesProfile | null>(null)
  const detailMap = ref<Record<string, HermesProfileDetail>>({})
  const loading = ref(false)
  const switching = ref(false)
  // Guard: when true, fetchProfiles() must NOT overwrite activeProfileName.
  // Set by switchProfileSmooth to prevent the watcher in ChatView from
  // firing multiple times during a profile switch.
  let _suppressActiveoverwrite = false

  async function fetchProfiles() {
    loading.value = true
    try {
      profiles.value = await profilesApi.fetchProfiles()
      activeProfile.value = profiles.value.find(p => p.active) ?? null
      // 同步缓存 profile name，供其他 store 启动时读取
      // Skip if a smooth switch is in progress — the caller sets the correct value.
      if (!_suppressActiveoverwrite && activeProfile.value) {
        activeProfileName.value = activeProfile.value.name
        localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, activeProfile.value.name)
        // Also update backend config for the active profile
        updateProfileBackendConfig(activeProfile.value.name)
      }
    } catch (err) {
      console.error('Failed to fetch profiles:', err)
    } finally {
      loading.value = false
    }
  }

  async function fetchProfileDetail(name: string) {
    if (detailMap.value[name]) return detailMap.value[name]
    try {
      const detail = await profilesApi.fetchProfileDetail(name)
      detailMap.value[name] = detail
      return detail
    } catch {
      return null
    }
  }

  async function createProfile(name: string, clone?: boolean) {
    const ok = await profilesApi.createProfile(name, clone)
    if (ok) await fetchProfiles()
    return ok
  }

  async function deleteProfile(name: string) {
    const ok = await profilesApi.deleteProfile(name)
    if (ok) {
      delete detailMap.value[name]
      // 清理该 profile 的 localStorage 缓存
      clearProfileCache(name)
      await fetchProfiles()
    }
    return ok
  }

  // 清理指定 profile 的所有 localStorage 缓存（精确匹配缓存 key 前缀）
  function clearProfileCache(profileName: string) {
    const prefixes = [
      `hermes_sessions_cache_v1_${profileName}`,
      `hermes_session_msgs_v1_${profileName}_`,
      `hermes_in_flight_v1_${profileName}_`,
      `hermes_active_session_${profileName}`,
      `hermes_session_pins_v1_${profileName}`,
      `hermes_human_only_v1_${profileName}`,
    ]
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && prefixes.some(p => key.startsWith(p))) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key))
  }

  async function renameProfile(name: string, newName: string) {
    const ok = await profilesApi.renameProfile(name, newName)
    if (ok) {
      delete detailMap.value[name]
      await fetchProfiles()
    }
    return ok
  }

  async function switchProfile(name: string) {
    switching.value = true
    try {
      const ok = await profilesApi.switchProfile(name)
      if (ok) await fetchProfiles()
      return ok
    } finally {
      switching.value = false
    }
  }

  /**
   * Smooth profile switch — no page reload.
   * Calls the API, updates local state & localStorage, then returns.
   * The caller (chat store) is responsible for refreshing sessions.
   */
  async function switchProfileSmooth(name: string): Promise<boolean> {
    if (name === activeProfileName.value) return true
    switching.value = true
    _suppressActiveoverwrite = true
    try {
      const ok = await profilesApi.switchProfile(name)
      if (!ok) return false

      // Update backend config FIRST — before activeProfileName changes,
      // so ChatView's watcher reads the correct backend_url from localStorage.
      updateProfileBackendConfig(name)

      // Persist for other stores / cold-start
      localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, name)

      // Update local reactive state — this triggers ChatView's watcher
      activeProfileName.value = name
      activeProfile.value = profiles.value.find(p => p.name === name) ?? null

      // Refresh the profiles list so the "active" flag is correct server-side.
      // fetchProfiles() will NOT overwrite activeProfileName because the guard is set.
      await fetchProfiles()

      return true
    } catch (err) {
      console.error('Smooth profile switch failed:', err)
      return false
    } finally {
      _suppressActiveoverwrite = false
      switching.value = false
    }
  }

  /**
   * Update localStorage with the backend config for the given profile.
   * If the profile has a backend_url, all API requests will be sent there.
   * If not, requests go to the default server URL (local BFF).
   */
  function updateProfileBackendConfig(name: string) {
    const profile = profiles.value.find(p => p.name === name)
    if (profile?.backend_url) {
      localStorage.setItem('hermes_profile_backend_url', profile.backend_url)
      localStorage.setItem('hermes_profile_backend_token', profile.backend_token || '')
    } else {
      localStorage.removeItem('hermes_profile_backend_url')
      localStorage.removeItem('hermes_profile_backend_token')
    }
  }

  async function exportProfile(name: string) {
    return profilesApi.exportProfile(name)
  }

  async function importProfile(file: File) {
    const ok = await profilesApi.importProfile(file)
    if (ok) await fetchProfiles()
    return ok
  }

  return {
    profiles,
    activeProfile,
    activeProfileName,
    detailMap,
    loading,
    switching,
    fetchProfiles,
    fetchProfileDetail,
    createProfile,
    deleteProfile,
    renameProfile,
    switchProfile,
    switchProfileSmooth,
    exportProfile,
    importProfile,
    updateProfileBackendConfig,
  }
})

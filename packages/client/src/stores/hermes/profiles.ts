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

  async function fetchProfiles() {
    loading.value = true
    try {
      profiles.value = await profilesApi.fetchProfiles()
      activeProfile.value = profiles.value.find(p => p.active) ?? null
      // 同步缓存 profile name，供其他 store 启动时读取
      if (activeProfile.value) {
        activeProfileName.value = activeProfile.value.name
        localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, activeProfile.value.name)
      }
      // 清理所有会话缓存（不再使用 localStorage 缓存）
      clearAllSessionCaches()
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
    const res = await profilesApi.createProfile(name, clone)
    if (res.success) await fetchProfiles()
    return res
  }

  async function deleteProfile(name: string) {
    const ok = await profilesApi.deleteProfile(name)
    if (ok) {
      delete detailMap.value[name]
      await fetchProfiles()
    }
    return ok
  }

  // 清理所有 profile 的会话缓存
  function clearAllSessionCaches() {
    // 注意：不再清理任何缓存，因为已经不再使用 localStorage 缓存会话数据
    // 所有会话数据都从服务器实时获取
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
      if (ok) {
        // 立即更新 activeProfileName，确保前端显示正确
        // 不要完全依赖 fetchProfiles 的返回值，以防后端数据同步延迟
        activeProfileName.value = name
        localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, name)
        // 尝试刷新 profiles 列表，但不让它影响切换结果
        try {
          await fetchProfiles()
        } catch (err) {
          // fetchProfiles 失败不影响切换结果，activeProfileName 已经正确设置
          console.warn('Failed to refresh profiles list after switch, but profile was switched successfully:', err)
        }
      }
      return ok
    } finally {
      switching.value = false
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
    exportProfile,
    importProfile,
    clearAllSessionCaches,
  }
})

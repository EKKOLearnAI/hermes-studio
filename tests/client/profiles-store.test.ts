// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const mockProfilesApi = vi.hoisted(() => ({
  fetchProfiles: vi.fn(),
  fetchProfileDetail: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  switchProfile: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
  updateProfileAvatar: vi.fn(),
  deleteProfileAvatar: vi.fn(),
}))

vi.mock('@/api/hermes/profiles', () => mockProfilesApi)

import { useProfilesStore } from '@/stores/hermes/profiles'

describe('Profiles Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('fetchProfiles loads profiles and sets active', async () => {
    const profiles = [
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
      { name: 'dev', active: false, model: 'gpt-4', alias: '' },
    ]
    mockProfilesApi.fetchProfiles.mockResolvedValue(profiles)

    const store = useProfilesStore()
    await store.fetchProfiles()

    expect(store.profiles).toEqual(profiles)
    expect(store.activeProfile?.name).toBe('default')
    expect(store.loading).toBe(false)
  })

  it('fetchProfiles sets loading state', async () => {
    mockProfilesApi.fetchProfiles.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve([]), 10))
    )

    const store = useProfilesStore()
    const fetchPromise = store.fetchProfiles()

    expect(store.loading).toBe(true)
    await fetchPromise
    expect(store.loading).toBe(false)
  })

  it('createProfile calls API and refreshes list', async () => {
    mockProfilesApi.createProfile.mockResolvedValue({ success: true })
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
      { name: 'new-profile', active: false, model: 'gpt-4', alias: '' },
    ])

    const store = useProfilesStore()
    const result = await store.createProfile('new-profile', false)

    expect(result.success).toBe(true)
    expect(mockProfilesApi.createProfile).toHaveBeenCalledWith('new-profile', false)
    expect(store.profiles).toHaveLength(2)
  })

  it('deleteProfile clears detail cache', async () => {
    mockProfilesApi.deleteProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
    ])

    const store = useProfilesStore()
    store.detailMap['test'] = { name: 'test', path: '/tmp/test', model: '', provider: '', skills: 0, hasEnv: false, hasSoulMd: false }

    await store.deleteProfile('test')

    expect(store.detailMap['test']).toBeUndefined()
    expect(mockProfilesApi.deleteProfile).toHaveBeenCalledWith('test')
  })

  it('fetchProfileDetail uses cache', async () => {
    const detail = { name: 'cached', path: '/tmp/cached', model: 'gpt-4', provider: 'openai', skills: 5, hasEnv: true, hasSoulMd: false }
    const store = useProfilesStore()
    store.detailMap['cached'] = detail

    const result = await store.fetchProfileDetail('cached')

    expect(result).toEqual(detail)
    expect(mockProfilesApi.fetchProfileDetail).not.toHaveBeenCalled()
  })

  it('updateAvatar updates profile, detail cache, and active profile', async () => {
    const savedAvatar = { type: 'image', dataUrl: 'data:image/png;base64,YQ==' }
    mockProfilesApi.updateProfileAvatar.mockResolvedValue(savedAvatar)

    const store = useProfilesStore()
    store.profiles = [
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
      { name: 'dev', active: false, model: 'gpt-4', alias: '' },
    ]
    store.activeProfile = store.profiles[0]
    store.detailMap.default = { name: 'default', path: '/tmp/default', model: '', provider: '', skills: 0, hasEnv: false, hasSoulMd: false }

    const result = await store.updateAvatar('default', { type: 'image', dataUrl: savedAvatar.dataUrl })

    expect(result).toEqual(savedAvatar)
    expect(mockProfilesApi.updateProfileAvatar).toHaveBeenCalledWith('default', { type: 'image', dataUrl: savedAvatar.dataUrl })
    expect(store.profiles[0].avatar).toEqual(savedAvatar)
    expect(store.activeProfile?.avatar).toEqual(savedAvatar)
    expect(store.detailMap.default.avatar).toEqual(savedAvatar)
  })

  it('deleteAvatar clears avatar state', async () => {
    mockProfilesApi.deleteProfileAvatar.mockResolvedValue(undefined)

    const store = useProfilesStore()
    store.profiles = [
      { name: 'default', active: true, model: 'gpt-4', alias: '', avatar: { type: 'generated', seed: 'old' } },
    ]
    store.activeProfile = store.profiles[0]
    store.detailMap.default = {
      name: 'default',
      path: '/tmp/default',
      model: '',
      provider: '',
      skills: 0,
      hasEnv: false,
      hasSoulMd: false,
      avatar: { type: 'generated', seed: 'old' },
    }

    await store.deleteAvatar('default')

    expect(mockProfilesApi.deleteProfileAvatar).toHaveBeenCalledWith('default')
    expect(store.profiles[0].avatar).toBeNull()
    expect(store.activeProfile?.avatar).toBeNull()
    expect(store.detailMap.default.avatar).toBeNull()
  })

  it('switchProfile sets switching state', async () => {
    mockProfilesApi.switchProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([])

    const store = useProfilesStore()
    const switchPromise = store.switchProfile('dev')

    expect(store.switching).toBe(true)
    await switchPromise
    expect(store.switching).toBe(false)
  })

  it('switchProfile updates activeProfileName immediately', async () => {
    mockProfilesApi.switchProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: false, model: 'gpt-4', alias: '' },
      { name: 'dev', active: true, model: 'gpt-4', alias: '' },
    ])

    const store = useProfilesStore()
    await store.switchProfile('dev')

    // activeProfileName should be updated immediately
    expect(store.activeProfileName).toBe('dev')
    // localStorage should also be updated
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('dev')
  })

  it('switchProfile does not update state when API fails', async () => {
    const initialName = 'default'
    localStorage.setItem('hermes_active_profile_name', initialName)

    mockProfilesApi.switchProfile.mockResolvedValue(false)  // API failed

    const store = useProfilesStore()
    store.activeProfileName = initialName
    const result = await store.switchProfile('dev')

    // Should return false
    expect(result).toBe(false)
    // activeProfileName should NOT change
    expect(store.activeProfileName).toBe(initialName)
    // localStorage should NOT change
    expect(localStorage.getItem('hermes_active_profile_name')).toBe(initialName)
  })

  it('switchProfile keeps activeProfileName even if fetchProfiles fails', async () => {
    const initialName = 'default'
    localStorage.setItem('hermes_active_profile_name', initialName)

    mockProfilesApi.switchProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockRejectedValue(new Error('Network error'))

    const store = useProfilesStore()
    store.activeProfileName = initialName
    const result = await store.switchProfile('dev')

    // Should return true (API succeeded)
    expect(result).toBe(true)
    // activeProfileName should be updated even though fetchProfiles failed
    expect(store.activeProfileName).toBe('dev')
    // localStorage should be updated
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('dev')
  })

  it('switchProfile rolls back if backend reports different active profile', async () => {
    const initialName = 'default'
    localStorage.setItem('hermes_active_profile_name', initialName)

    mockProfilesApi.switchProfile.mockResolvedValue(true)
    // Backend returns success, but active profile is still default (not the one we switched to)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
      { name: 'dev', active: false, model: 'gpt-4', alias: '' },
    ])

    const store = useProfilesStore()
    store.activeProfileName = initialName
    const result = await store.switchProfile('dev')

    // Should return false (backend verification failed)
    expect(result).toBe(false)
    // activeProfileName should be rolled back to default
    expect(store.activeProfileName).toBe('default')
    // localStorage should be rolled back
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('default')
  })
})

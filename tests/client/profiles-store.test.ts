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
      { name: 'default', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
      { name: 'dev', active: false, model: 'gpt-4', gateway: 'stopped', alias: '' },
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
    mockProfilesApi.createProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
      { name: 'new-profile', active: false, model: 'gpt-4', gateway: 'stopped', alias: '' },
    ])

    const store = useProfilesStore()
    const ok = await store.createProfile('new-profile', false)

    expect(ok).toBe(true)
    expect(mockProfilesApi.createProfile).toHaveBeenCalledWith('new-profile', false)
    expect(store.profiles).toHaveLength(2)
  })

  it('deleteProfile clears detail cache', async () => {
    mockProfilesApi.deleteProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', gateway: 'running', alias: '' },
    ])

    window.localStorage.setItem('hermes_sessions_cache_v1_test', '[]')
    window.localStorage.setItem('hermes_session_msgs_v1_test_session-1', '[]')
    window.localStorage.setItem('hermes_in_flight_v1_test_session-1', '{}')
    window.localStorage.setItem('hermes_active_session_test', 'session-1')
    window.localStorage.setItem('hermes_session_pins_v1_test', '[]')
    window.localStorage.setItem('hermes_human_only_v1_test', 'false')

    const store = useProfilesStore()
    store.detailMap['test'] = { name: 'test', path: '/tmp/test', model: '', provider: '', gateway: '', skills: 0, hasEnv: false, hasSoulMd: false }

    await store.deleteProfile('test')

    expect(store.detailMap['test']).toBeUndefined()
    expect(window.localStorage.getItem('hermes_session_pins_v1_test')).toBeNull()
    expect(window.localStorage.getItem('hermes_human_only_v1_test')).toBeNull()
  })

  it('fetchProfileDetail uses cache', async () => {
    const detail = { name: 'cached', path: '/tmp/cached', model: 'gpt-4', provider: 'openai', gateway: 'running', skills: 5, hasEnv: true, hasSoulMd: false }
    const store = useProfilesStore()
    store.detailMap['cached'] = detail

    const result = await store.fetchProfileDetail('cached')

    expect(result).toEqual(detail)
    expect(mockProfilesApi.fetchProfileDetail).not.toHaveBeenCalled()
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
})

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  fetchAssistantRoles: vi.fn(),
  fetchAssistantRole: vi.fn(),
  createAssistantRole: vi.fn(),
  updateAssistantRole: vi.fn(),
  deleteAssistantRole: vi.fn(),
  cloneAssistantRole: vi.fn(),
  updateAssistantRoleProfileMapping: vi.fn(),
  previewAssistantRoleContext: vi.fn(),
}))
vi.mock('@/api/hermes/assistant-roles', () => api)

import { useAssistantRolesStore } from '@/stores/hermes/assistant-roles'

const health = { id: 'health', name: 'Health', recipes: [] }
const coach = { id: 'coach', name: 'Coach', recipes: [] }

describe('assistant roles store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    api.fetchAssistantRoles.mockResolvedValue([health])
    api.fetchAssistantRole.mockImplementation(async (id: string) => id === 'coach' ? coach : health)
  })

  it('loads roles and preserves a valid selection', async () => {
    const store = useAssistantRolesStore()
    store.selectedRoleId = 'health'
    await store.fetchRoles()
    expect(store.roles).toEqual([health])
    expect(store.selectedRoleId).toBe('health')
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('selects the first role when the current selection disappears', async () => {
    const store = useAssistantRolesStore()
    store.selectedRoleId = 'missing'
    await store.fetchRoles()
    expect(store.selectedRoleId).toBe('health')
  })

  it('refreshes the authoritative list after create, clone, and delete', async () => {
    api.createAssistantRole.mockResolvedValue(coach)
    api.cloneAssistantRole.mockResolvedValue(coach)
    api.deleteAssistantRole.mockResolvedValue(undefined)
    const store = useAssistantRolesStore()

    await store.createRole({ name: 'Coach' } as never)
    expect(store.selectedRoleId).toBe('coach')
    await store.cloneRole('health', { name: 'Coach' })
    await store.deleteRole('coach')

    expect(api.fetchAssistantRoles).toHaveBeenCalledTimes(3)
    expect(api.deleteAssistantRole).toHaveBeenCalledWith('coach')
    expect(store.saving).toBe(false)
  })

  it('refreshes the affected role and list after update and mapping changes', async () => {
    api.updateAssistantRole.mockResolvedValue(health)
    api.updateAssistantRoleProfileMapping.mockResolvedValue(null)
    const store = useAssistantRolesStore()

    await store.updateRole('health', { name: 'Health lead' })
    await store.updateProfileMapping('health', null)

    expect(api.fetchAssistantRole).toHaveBeenCalledTimes(2)
    expect(api.fetchAssistantRoles).toHaveBeenCalledTimes(2)
    expect(store.roles).toEqual([health])
  })

  it('keeps loading true until concurrent loads settle', async () => {
    let resolveFirst!: (value: typeof health[]) => void
    api.fetchAssistantRoles
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce([coach])
    const store = useAssistantRolesStore()

    const first = store.fetchRoles()
    const second = store.fetchRoles()
    await second
    expect(store.loading).toBe(true)
    resolveFirst([health])
    await first
    expect(store.loading).toBe(false)
  })

  it('keeps saving true until concurrent mutations settle and reports errors', async () => {
    let resolveUpdate!: (value: typeof health) => void
    api.updateAssistantRole.mockImplementationOnce(() => new Promise(resolve => { resolveUpdate = resolve }))
    api.updateAssistantRoleProfileMapping.mockRejectedValueOnce(new Error('mapping failed'))
    const store = useAssistantRolesStore()

    const update = store.updateRole('health', { name: 'Lead' })
    const mapping = store.updateProfileMapping('health', 'main')
    await expect(mapping).rejects.toThrow('mapping failed')
    expect(store.saving).toBe(true)
    expect(store.error).toBe('mapping failed')
    resolveUpdate(health)
    await update
    expect(store.saving).toBe(false)
    expect(store.error).toBe('mapping failed')
  })

  it('keeps the newest preview when concurrent requests resolve out of order', async () => {
    let resolveFirst!: (value: { renderedInstructions: string }) => void
    api.previewAssistantRoleContext
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ renderedInstructions: 'newest' })
    const store = useAssistantRolesStore()

    const first = store.previewContext('health', { query: 'first' })
    await store.previewContext('health', { query: 'second' })
    resolveFirst({ renderedInstructions: 'stale' })
    await first

    expect(store.preview).toEqual({ renderedInstructions: 'newest' })
  })

  it('stores only server-generated previews and cleans up preview errors', async () => {
    const context = { renderedInstructions: 'Authoritative server context' }
    api.previewAssistantRoleContext.mockResolvedValueOnce(context)
    const store = useAssistantRolesStore()
    await expect(store.previewContext('health', { query: 'today' })).resolves.toEqual(context)
    expect(store.preview).toEqual(context)

    api.previewAssistantRoleContext.mockRejectedValueOnce('offline')
    await expect(store.previewContext('health', {})).rejects.toBe('offline')
    expect(store.preview).toBeNull()
    expect(store.error).toBe('offline')
    expect(store.saving).toBe(false)
  })
})

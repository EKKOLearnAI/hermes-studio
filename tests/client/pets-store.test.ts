// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ActivePet } from '@/api/hermes/pets'

const mockPetsApi = vi.hoisted(() => ({
  fetchActivePet: vi.fn(),
  adoptPet: vi.fn(),
  updateActivePetPreferences: vi.fn(),
}))

vi.mock('@/api/hermes/pets', () => mockPetsApi)

import { usePetsStore } from '@/stores/hermes/pets'

function activePet(overrides: Partial<ActivePet> = {}): ActivePet {
  return {
    enabled: true,
    slug: 'desk-cat',
    displayName: 'Desk Cat',
    kind: 'cat',
    submittedBy: 'petdex',
    source: 'petdex',
    mime: 'image/webp',
    spritesheetDataUrl: 'data:image/webp;base64,AA==',
    spritesheetRevision: 1,
    frameW: 192,
    frameH: 208,
    framesPerState: 6,
    loopMs: 1100,
    scale: 0.33,
    position: { x: 10, y: 20 },
    stateRows: ['idle'],
    installedAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Pets Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('disables and clears the active pet when hiding it', async () => {
    const store = usePetsStore()
    store.activePet = activePet()
    mockPetsApi.updateActivePetPreferences.mockResolvedValue(null)

    await store.hideActivePet()

    expect(mockPetsApi.updateActivePetPreferences).toHaveBeenCalledWith({ enabled: false })
    expect(store.activePet).toBeNull()
    expect(store.hasActivePet).toBe(false)
    expect(store.saving).toBe(false)
  })
})

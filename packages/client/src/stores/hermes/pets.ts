import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as petsApi from '@/api/hermes/pets'
import type { ActivePet, WebPetPosition } from '@/api/hermes/pets'

export const usePetsStore = defineStore('pets', () => {
  const activePet = ref<ActivePet | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')

  const hasActivePet = computed(() => !!activePet.value?.enabled)

  async function loadActivePet(): Promise<ActivePet | null> {
    loading.value = true
    error.value = ''
    try {
      activePet.value = await petsApi.fetchActivePet()
      return activePet.value
    } catch (err: any) {
      error.value = err?.message || 'Failed to load active pet'
      activePet.value = null
      return null
    } finally {
      loading.value = false
    }
  }

  async function adopt(slug: string): Promise<ActivePet> {
    saving.value = true
    error.value = ''
    try {
      activePet.value = await petsApi.adoptPet(slug)
      return activePet.value
    } catch (err: any) {
      error.value = err?.message || 'Failed to adopt pet'
      throw err
    } finally {
      saving.value = false
    }
  }

  async function savePreferences(input: { scale?: number; position?: WebPetPosition }): Promise<void> {
    if (!activePet.value) return
    activePet.value = {
      ...activePet.value,
      ...(typeof input.scale === 'number' ? { scale: input.scale } : {}),
      ...(input.position ? { position: input.position } : {}),
    }
    saving.value = true
    try {
      const saved = await petsApi.updateActivePetPreferences(input)
      if (saved) activePet.value = saved
    } finally {
      saving.value = false
    }
  }

  function clear(): void {
    activePet.value = null
    error.value = ''
  }

  return {
    activePet,
    loading,
    saving,
    error,
    hasActivePet,
    loadActivePet,
    adopt,
    savePreferences,
    clear,
  }
})

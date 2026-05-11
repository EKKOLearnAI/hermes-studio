import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as systemApi from '@/api/hermes/system'
import type { AvailableModelGroup, CustomProvider } from '@/api/hermes/system'
import { useAppStore } from './app'

export const useModelsStore = defineStore('models', () => {
  const providers = ref<AvailableModelGroup[]>([])
  const allProviders = ref<AvailableModelGroup[]>([])
  const defaultModel = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)
  const isAuthError = ref(false)

  const customProviders = computed(() =>
    providers.value.filter(g => g.provider.startsWith('custom:')),
  )

  const builtinProviders = computed(() =>
    providers.value.filter(g => !g.provider.startsWith('custom:')),
  )

  const allModels = computed(() =>
    providers.value.flatMap(g =>
      g.models.map(m => ({
        id: m,
        provider: g.provider,
        label: g.label,
        base_url: g.base_url,
        isDefault: m === defaultModel.value,
      })),
    ),
  )

  async function fetchProviders() {
    loading.value = true
    error.value = null
    
    // Skip if we already hit an auth error
    if (isAuthError.value) {
      console.warn('[fetchProviders] Skipping due to previous auth error')
      loading.value = false
      return
    }

    try {
      const res = await systemApi.fetchAvailableModels()
      providers.value = res.groups
      allProviders.value = res.allProviders
      defaultModel.value = res.default
      const appStore = useAppStore()
      appStore.applyAvailableModelsResponse(res)
      // Clear auth error flag on success
      isAuthError.value = false
    } catch (err: any) {
      const errorMessage = err?.message || String(err)
      error.value = errorMessage

      // Check if it's an auth error
      if (errorMessage.includes('Unauthorized') || err?.status === 401) {
        isAuthError.value = true
        console.error('[fetchProviders] Auth error, will not retry:', err)
      } else {
        console.error('Failed to fetch providers:', err)
      }

      // Re-throw for upstream handling
      throw err
    } finally {
      loading.value = false
    }
  }

  async function setDefaultModel(modelId: string, provider: string) {
    await systemApi.updateDefaultModel({ default: modelId, provider })
    defaultModel.value = modelId
    const appStore = useAppStore()
    appStore.loadModels()
  }

  async function addProvider(data: CustomProvider) {
    await systemApi.addCustomProvider(data)
    await fetchProviders()
    const appStore = useAppStore()
    appStore.loadModels()
  }

  async function removeProvider(name: string) {
    await systemApi.removeCustomProvider(name)
    await fetchProviders()
    const appStore = useAppStore()
    appStore.loadModels()
  }

  return {
    providers,
    allProviders,
    defaultModel,
    loading,
    error,
    isAuthError,
    customProviders,
    builtinProviders,
    allModels,
    fetchProviders,
    setDefaultModel,
    addProvider,
    removeProvider,
  }
})

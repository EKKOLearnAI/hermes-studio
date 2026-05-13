import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  checkHealth,
  fetchAvailableModels,
  updateDefaultModel,
  updateModelVisibility,
  triggerUpdate,
  updateModelAlias,
  type AvailableModelGroup,
  type AvailableModelsResponse,
  type ModelVisibility,
  type ModelVisibilityRule,
} from '@/api/hermes/system'
import { hasApiKey } from '@/api/client'

const WEB_UI_VERSION = __APP_VERSION__

const SIDEBAR_COLLAPSED_KEY = 'hermes_sidebar_collapsed'

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  // Desktop-only collapsed state (icon-rail mode). Persisted to localStorage.
  const sidebarCollapsed = ref(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1')

  const connected = ref(false)
  const serverVersion = ref(WEB_UI_VERSION)
  const latestVersion = ref('')
  const updateAvailable = ref(false)
  const clientOutdated = ref(false)
  const updating = ref(false)
  const modelGroups = ref<AvailableModelGroup[]>([])
  const selectedModel = ref('')
  const selectedProvider = ref('')
  const customModels = ref<Record<string, string[]>>({})
  const modelAliases = ref<Record<string, Record<string, string>>>({})
  const modelVisibility = ref<ModelVisibility>({})
  const healthPollTimer = ref<ReturnType<typeof setInterval>>()
  const nodeVersion = ref('')

  // Settings
  const streamEnabled = ref(true)
  const sessionPersistence = ref(true)
  const maxTokens = ref(4096)

  async function doUpdate(): Promise<boolean> {
    updating.value = true
    try {
      const res = await triggerUpdate()
      if (res.success) {
        updateAvailable.value = false
        await checkConnection()
      }
      return res.success
    } catch (err) {
      console.error('Failed to update Hermes Web UI:', err)
      return false
    } finally {
      updating.value = false
    }
  }

  async function checkConnection() {
    try {
      const res = await checkHealth()
      connected.value = res.status === 'ok'
      if (res.webui_version) serverVersion.value = res.webui_version
      clientOutdated.value = !!res.webui_version && res.webui_version !== WEB_UI_VERSION
      if (res.webui_latest) latestVersion.value = res.webui_latest
      updateAvailable.value = !!res.webui_update_available
      if (res.node_version) nodeVersion.value = res.node_version
    } catch {
      connected.value = false
      clientOutdated.value = false
    }
  }

  function applyAvailableModelsResponse(res: AvailableModelsResponse) {
    modelGroups.value = res.groups
    modelAliases.value = res.model_aliases || {}
    modelVisibility.value = res.model_visibility || {}

    const defaultModel = res.default || ''
    const defaultProvider = res.default_provider || ''
    const explicitGroup = res.groups.find(g => g.provider === defaultProvider && g.models.includes(defaultModel))
    const inferredGroup = res.groups.find(g => g.models.includes(defaultModel))
    const fallbackGroup = res.groups.find(g => g.models.length > 0)

    const providerGroup = defaultProvider ? res.groups.find(g => g.provider === defaultProvider) : undefined
    const allProvider = defaultProvider ? res.allProviders.find(g => g.provider === defaultProvider) : undefined
    const providerCatalog = providerGroup?.available_models?.length
      ? providerGroup.available_models
      : allProvider?.available_models?.length
        ? allProvider.available_models
        : allProvider?.models || []
    const visibilityRule = defaultProvider ? modelVisibility.value[defaultProvider] : undefined
    const hiddenByVisibility = !!(
      defaultModel &&
      visibilityRule?.mode === 'include' &&
      !visibilityRule.models.includes(defaultModel) &&
      (providerCatalog.length === 0 || providerCatalog.includes(defaultModel))
    )
    const unlistedDefault = !!(
      defaultModel &&
      defaultProvider &&
      providerGroup &&
      !providerGroup.models.includes(defaultModel) &&
      !hiddenByVisibility
    )

    if (explicitGroup || inferredGroup) {
      const selectedGroup = explicitGroup || inferredGroup!
      selectedModel.value = defaultModel
      selectedProvider.value = selectedGroup.provider
      customModels.value = {}
    } else if (unlistedDefault) {
      selectedModel.value = defaultModel
      selectedProvider.value = defaultProvider
      customModels.value = { [defaultProvider]: [defaultModel] }
    } else if (fallbackGroup) {
      selectedModel.value = fallbackGroup.models[0]
      selectedProvider.value = fallbackGroup.provider
      customModels.value = {}
    } else {
      selectedModel.value = ''
      selectedProvider.value = ''
      customModels.value = {}
    }
  }

  async function loadModels() {
    if (!hasApiKey()) return
    try {
      const res = await fetchAvailableModels()
      applyAvailableModelsResponse(res)
    } catch {
      // ignore
    }
  }

  function getModelAlias(modelId: string, provider?: string): string {
    if (provider) return modelAliases.value[provider]?.[modelId] || ''
    for (const aliases of Object.values(modelAliases.value)) {
      if (aliases[modelId]) return aliases[modelId]
    }
    return ''
  }

  function displayModelName(modelId: string, provider?: string): string {
    return getModelAlias(modelId, provider) || modelId
  }

  async function setModelAlias(modelId: string, provider: string, alias: string) {
    const cleanAlias = alias.trim()
    await updateModelAlias({ provider, model: modelId, alias: cleanAlias })
    const next = { ...modelAliases.value }
    const providerAliases = { ...(next[provider] || {}) }
    if (cleanAlias) {
      providerAliases[modelId] = cleanAlias
      next[provider] = providerAliases
    } else {
      delete providerAliases[modelId]
      if (Object.keys(providerAliases).length > 0) next[provider] = providerAliases
      else delete next[provider]
    }
    modelAliases.value = next
  }

  async function switchModel(modelId: string, providerOverride?: string) {
    try {
      // Find the group containing this model to get provider info
      const group = modelGroups.value.find(g => g.models.includes(modelId))
      const provider = providerOverride || group?.provider || ''
      await updateDefaultModel({ default: modelId, provider })
      selectedModel.value = modelId
      selectedProvider.value = provider || ''
      // Track as custom if not already in the server-fetched list
      if (provider && !modelGroups.value.find(g => g.provider === provider)?.models.includes(modelId)) {
        if (!customModels.value[provider]) customModels.value[provider] = []
        if (!customModels.value[provider].includes(modelId)) {
          customModels.value[provider] = [...customModels.value[provider], modelId]
        }
      }
    } catch (err: any) {
      console.error('Failed to switch model:', err)
    }
  }

  async function removeCustomModel(modelId: string, provider: string) {
    const providerModels = customModels.value[provider] || []
    if (!providerModels.includes(modelId)) return

    const nextCustomModels = { ...customModels.value }
    const remaining = providerModels.filter(m => m !== modelId)
    if (remaining.length > 0) nextCustomModels[provider] = remaining
    else delete nextCustomModels[provider]
    customModels.value = nextCustomModels

    if (selectedModel.value === modelId && selectedProvider.value === provider) {
      const providerGroup = modelGroups.value.find(g => g.provider === provider && g.models.length > 0)
      const fallbackGroup = providerGroup || modelGroups.value.find(g => g.models.length > 0)
      if (fallbackGroup) {
        await switchModel(fallbackGroup.models[0], fallbackGroup.provider)
      } else {
        selectedModel.value = ''
        selectedProvider.value = ''
      }
    }
  }

  function getProviderVisibility(provider: string): ModelVisibilityRule {
    return modelVisibility.value[provider] || { mode: 'all', models: [] }
  }

  function isModelVisible(provider: string, model: string): boolean {
    const rule = getProviderVisibility(provider)
    return rule.mode !== 'include' || rule.models.includes(model)
  }

  async function setModelVisibility(provider: string, rule: ModelVisibilityRule) {
    const res = await updateModelVisibility({ provider, mode: rule.mode, models: rule.models })
    modelVisibility.value = res.model_visibility || {}
    await loadModels()
  }

  function startHealthPolling(interval = 30000) {
    stopHealthPolling()
    checkConnection()
    healthPollTimer.value = setInterval(checkConnection, interval)
  }

  function stopHealthPolling() {
    if (healthPollTimer.value) {
      clearInterval(healthPollTimer.value)
      healthPollTimer.value = undefined
    }
  }

  function reloadClient() {
    const url = new URL(window.location.href)
    url.searchParams.set('__hwui_reload', Date.now().toString())
    window.location.replace(url.toString())
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebar() {
    sidebarOpen.value = false
  }

  function toggleSidebarCollapsed() {
    sidebarCollapsed.value = !sidebarCollapsed.value
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed.value ? '1' : '0')
    } catch {
      // ignore quota errors — fallback to in-memory only
    }
  }

  return {
    sidebarOpen,
    sidebarCollapsed,
    toggleSidebar,
    closeSidebar,
    toggleSidebarCollapsed,
    connected,
    serverVersion,
    latestVersion,
    nodeVersion,
    updateAvailable,
    clientOutdated,
    updating,
    doUpdate,
    reloadClient,
    modelGroups,
    customModels,
    modelAliases,
    modelVisibility,
    selectedModel,
    selectedProvider,
    streamEnabled,
    sessionPersistence,
    maxTokens,
    checkConnection,
    loadModels,
    applyAvailableModelsResponse,
    switchModel,
    removeCustomModel,
    getModelAlias,
    displayModelName,
    setModelAlias,
    getProviderVisibility,
    isModelVisible,
    setModelVisibility,
    startHealthPolling,
    stopHealthPolling,
  }
})

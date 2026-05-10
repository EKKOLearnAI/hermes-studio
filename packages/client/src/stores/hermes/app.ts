import { defineStore } from 'pinia'
import { ref } from 'vue'
import { checkHealth, fetchAvailableModels, updateDefaultModel, updateModelVisibility, triggerUpdate, type AvailableModelGroup, type AvailableModelsResponse, type ModelVisibility, type ModelVisibilityRule } from '@/api/hermes/system'

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
  const updating = ref(false)
  const modelGroups = ref<AvailableModelGroup[]>([])
  const selectedModel = ref('')
  const selectedProvider = ref('')
  const customModels = ref<Record<string, string[]>>({})
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
      if (res.webui_latest) latestVersion.value = res.webui_latest
      updateAvailable.value = !!res.webui_update_available
      if (res.node_version) nodeVersion.value = res.node_version
    } catch {
      connected.value = false
    }
  }

  function applyAvailableModelsResponse(res: AvailableModelsResponse) {
    modelGroups.value = res.groups
    modelVisibility.value = res.model_visibility || {}
    const defaultGroup = res.groups.find(g => g.provider === (res.default_provider || '') && g.models.includes(res.default))
    const inferredGroup = res.groups.find(g => g.models.includes(res.default))
    const fallbackGroup = res.groups.find(g => g.models.length > 0)
    const selectedGroup = defaultGroup || inferredGroup || fallbackGroup
    selectedModel.value = selectedGroup ? (defaultGroup || inferredGroup ? res.default : selectedGroup.models[0]) : ''
    selectedProvider.value = selectedGroup?.provider || ''
  }

  async function loadModels() {
    try {
      const res = await fetchAvailableModels()
      applyAvailableModelsResponse(res)
    } catch {
      // ignore
    }
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
    updating,
    doUpdate,
    modelGroups,
    customModels,
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
    getProviderVisibility,
    isModelVisible,
    setModelVisibility,
    startHealthPolling,
    stopHealthPolling,
  }
})

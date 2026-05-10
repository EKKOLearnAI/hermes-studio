import { defineStore } from 'pinia'
import { ref } from 'vue'
import { checkHealth, fetchAvailableModels, updateDefaultModel, triggerUpdate, updateModelAlias, type AvailableModelGroup } from '@/api/hermes/system'

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
  const modelAliases = ref<Record<string, Record<string, string>>>({})
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

  async function loadModels() {
    try {
      const res = await fetchAvailableModels()
      modelGroups.value = res.groups
      modelAliases.value = res.model_aliases || {}
      selectedModel.value = res.default
      selectedProvider.value = res.default_provider || ''
    } catch {
      // ignore
    }
  }

  function getModelAlias(modelId: string, provider?: string): string {
    if (provider && modelAliases.value[provider]?.[modelId]) return modelAliases.value[provider][modelId]
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
    modelAliases,
    selectedModel,
    selectedProvider,
    streamEnabled,
    sessionPersistence,
    maxTokens,
    checkConnection,
    loadModels,
    switchModel,
    getModelAlias,
    displayModelName,
    setModelAlias,
    startHealthPolling,
    stopHealthPolling,
  }
})

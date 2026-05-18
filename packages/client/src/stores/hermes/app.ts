import { defineStore } from 'pinia'
import { ref } from 'vue'
import { checkHealth, fetchAvailableModels, updateDefaultModel, type AvailableModelGroup } from '@/api/hermes/system'
import { setRuntimeMode } from '@/api/client'

const WEB_UI_VERSION = __APP_VERSION__

const SIDEBAR_COLLAPSED_KEY = 'hermes_sidebar_collapsed'
const MODELS_CACHE_TTL_MS = 60_000

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  // Desktop-only collapsed state (icon-rail mode). Persisted to localStorage.
  const sidebarCollapsed = ref(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1')

  const connected = ref(false)
  const serverVersion = ref(WEB_UI_VERSION)
  const modelGroups = ref<AvailableModelGroup[]>([])
  const selectedModel = ref('')
  const selectedProvider = ref('')
  const customModels = ref<Record<string, string[]>>({})
  const healthPollTimer = ref<ReturnType<typeof setInterval>>()
  const nodeVersion = ref('')
  const plane = ref(localStorage.getItem('hermes_web_plane') || 'both')
  const authMode = ref(localStorage.getItem('hermes_auth_mode') || 'token')
  const chatPlane = ref(plane.value === 'chat')

  // Settings
  const streamEnabled = ref(true)
  const sessionPersistence = ref(true)
  const maxTokens = ref(4096)
  let modelsLoadPromise: Promise<void> | null = null
  let modelsLastRequestedAt = 0

  async function checkConnection() {
    try {
      const res = await checkHealth()
      connected.value = res.status === 'ok'
      if (res.webui_version) serverVersion.value = res.webui_version
      if (res.node_version) nodeVersion.value = res.node_version
      if (res.plane) plane.value = res.plane
      if (res.auth_mode) authMode.value = res.auth_mode
      chatPlane.value = plane.value === 'chat'
      setRuntimeMode(authMode.value, plane.value)
    } catch {
      connected.value = false
    }
  }

  async function loadModels(force = false) {
    if (!force && modelsLoadPromise) return modelsLoadPromise
    if (!force && modelsLastRequestedAt > 0 && Date.now() - modelsLastRequestedAt < MODELS_CACHE_TTL_MS) return
    modelsLastRequestedAt = Date.now()
    modelsLoadPromise = (async () => {
      try {
        const res = await fetchAvailableModels()
        modelGroups.value = res.groups
        selectedModel.value = res.default
        selectedProvider.value = res.default_provider || ''
      } catch {
        // ignore
      } finally {
        modelsLoadPromise = null
      }
    })()
    return modelsLoadPromise
  }

  async function waitForModelsForRun(timeoutMs = 15000) {
    const pending = modelsLoadPromise || (modelsLastRequestedAt === 0 ? loadModels() : null)
    if (!pending) return
    await Promise.race([
      pending,
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ])
  }

  async function reloadModels() {
    return loadModels(true)
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
    nodeVersion,
    plane,
    authMode,
    chatPlane,
    modelGroups,
    customModels,
    selectedModel,
    selectedProvider,
    streamEnabled,
    sessionPersistence,
    maxTokens,
    checkConnection,
    loadModels,
    waitForModelsForRun,
    reloadModels,
    switchModel,
    startHealthPolling,
    stopHealthPolling,
  }
})

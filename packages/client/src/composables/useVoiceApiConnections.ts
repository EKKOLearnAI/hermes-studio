import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  clearTtsSecret,
  fetchTtsSettings,
  saveTtsSettings,
  type StoredTtsProvider,
  type TtsStoredSecretsInput,
  type TtsStoredSettings,
} from '@/api/hermes/tts-settings'
import {
  clearSttSecret,
  fetchSttSettings,
  saveActiveSttProvider,
  saveSttSettings,
  type StoredSttProvider,
  type SttProvider,
  type SttStoredSecretsInput,
  type SttStoredSettings,
} from '@/api/hermes/stt-settings'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { useSttSettings } from '@/composables/useSttSettings'
import { VOICE_API_PRESETS } from '@/constants/voiceApiPresets'
import type { VoiceApiConnection, VoiceApiKind, VoiceApiProvider, VoiceApiSavePayload } from '@/types/voice-api'

function isStoredSttProvider(provider: VoiceApiProvider): provider is StoredSttProvider {
  return provider === 'openai' || provider === 'custom'
}

function isStoredTtsProvider(provider: VoiceApiProvider): provider is StoredTtsProvider {
  return provider === 'edge' || provider === 'openai' || provider === 'custom' || provider === 'mimo'
}

function isSttProvider(provider: VoiceApiProvider): provider is SttProvider {
  return provider === 'browser' || provider === 'openai' || provider === 'custom'
}

function isTtsProvider(provider: VoiceApiProvider): provider is StoredTtsProvider {
  return provider === 'edge' || provider === 'openai' || provider === 'custom' || provider === 'mimo'
}

function stringSetting(settings: object, key: string): string {
  const value = (settings as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

export function useVoiceApiConnections() {
  const { t } = useI18n()
  const connections = ref<VoiceApiConnection[]>([])
  const loading = ref(false)
  const vs = useVoiceSettings()
  const stt = useSttSettings()

  const activeTtsId = computed(() => `tts-${vs.provider.value === 'webspeech' ? 'edge' : vs.provider.value}`)
  const activeSttId = computed(() => `stt-${stt.provider.value}`)

  const ttsConnections = computed(() => connections.value.filter(c => c.kind === 'tts'))
  const sttConnections = computed(() => connections.value.filter(c => c.kind === 'stt'))
  const activeTtsConnection = computed(() => ttsConnections.value.find(c => c.id === activeTtsId.value) || ttsConnections.value[0] || null)
  const activeSttConnection = computed(() => sttConnections.value.find(c => c.id === activeSttId.value) || sttConnections.value[0] || null)
  const ttsConnectionOptions = computed(() => ttsConnections.value.map(c => ({ label: c.label, value: c.id })))
  const sttConnectionOptions = computed(() => sttConnections.value.map(c => ({ label: c.label, value: c.id })))

  function applyTtsConnectionToLegacyState(connection: VoiceApiConnection) {
    if (!isTtsProvider(connection.provider)) return
    vs.setProvider(connection.provider)
    const settings = connection.settings

    if (connection.provider === 'edge') {
      vs.setEdgeVoice(stringSetting(settings, 'voice') || connection.voice || vs.edgeVoice.value)
      const rate = Number(settings.rate)
      const pitch = Number(settings.pitch)
      if (Number.isFinite(rate)) vs.setEdgeRate(rate)
      if (Number.isFinite(pitch)) vs.setEdgePitchHz(pitch)
      return
    }

    if (connection.provider === 'openai') {
      vs.setOpenaiBaseUrl(connection.baseUrl || stringSetting(settings, 'baseUrl'))
      vs.setOpenaiModel(connection.model || stringSetting(settings, 'model') || vs.openaiModel.value)
      vs.setOpenaiVoice(connection.voice || stringSetting(settings, 'voice') || vs.openaiVoice.value)
      return
    }

    if (connection.provider === 'custom') {
      vs.setCustomUrl(connection.baseUrl || stringSetting(settings, 'baseUrl'))
      return
    }

    if (connection.provider === 'mimo') {
      vs.setMimoBaseUrl(connection.baseUrl || stringSetting(settings, 'baseUrl') || vs.mimoBaseUrl.value)
      vs.setMimoModel(connection.model || stringSetting(settings, 'model') || vs.mimoModel.value)
      vs.setMimoVoice(connection.voice || stringSetting(settings, 'voice') || vs.mimoVoice.value)
      vs.setMimoStylePrompt(stringSetting(settings, 'stylePrompt'))
      vs.setMimoVoiceDesignDesc(stringSetting(settings, 'voiceDesignDesc'))
    }
  }

  function applySttConnectionToLegacyState(connection: VoiceApiConnection) {
    if (!isSttProvider(connection.provider)) return
    stt.setProvider(connection.provider)
    const settings = connection.settings

    if (connection.provider === 'openai') {
      stt.setOpenaiModel(connection.model || stringSetting(settings, 'model') || stt.openaiModel.value)
      stt.setOpenaiLanguage(stringSetting(settings, 'language'))
      stt.setOpenaiPrompt(stringSetting(settings, 'prompt'))
      return
    }

    if (connection.provider === 'custom') {
      stt.setCustomBaseUrl(connection.baseUrl || stringSetting(settings, 'baseUrl'))
      stt.setCustomModel(connection.model || stringSetting(settings, 'model') || stt.customModel.value)
      stt.setCustomLanguage(stringSetting(settings, 'language'))
      stt.setCustomPrompt(stringSetting(settings, 'prompt'))
    }
  }

  function makeTtsConnection(provider: StoredTtsProvider, settings: TtsStoredSettings, hasSecret: boolean): VoiceApiConnection {
    const preset = VOICE_API_PRESETS.find(pr => pr.kind === 'tts' && pr.provider === provider && (pr.baseUrl === settings.baseUrl || !pr.baseUrl))
    return {
      id: `tts-${provider}`,
      kind: 'tts',
      provider,
      label: preset?.labelKey ? t(preset.labelKey) : preset?.label || `${provider} TTS`,
      baseUrl: settings.baseUrl,
      model: settings.model,
      voice: settings.voice,
      settings: settings as Record<string, unknown>,
      hasSecret,
      active: activeTtsId.value === `tts-${provider}`,
    }
  }

  function makeSttConnection(provider: StoredSttProvider, settings: SttStoredSettings, hasSecret: boolean): VoiceApiConnection {
    const preset = VOICE_API_PRESETS.find(pr => pr.kind === 'stt' && pr.provider === provider && (pr.baseUrl === settings.baseUrl || !pr.baseUrl))
    return {
      id: `stt-${provider}`,
      kind: 'stt',
      provider,
      label: preset?.labelKey ? t(preset.labelKey) : preset?.label || `${provider} STT`,
      baseUrl: settings.baseUrl,
      model: settings.model,
      settings: settings as Record<string, unknown>,
      hasSecret,
      active: activeSttId.value === `stt-${provider}`,
    }
  }

  async function refresh() {
    loading.value = true
    try {
      await stt.loadServerSttSettings(true)
      const [ttsData, sttData] = await Promise.all([
        fetchTtsSettings(),
        fetchSttSettings(),
      ])

      const newConnections: VoiceApiConnection[] = [
        {
          id: 'tts-edge',
          kind: 'tts',
          provider: 'edge',
          label: t('settings.voice.presetEdgeTtsLabel'),
          isBuiltin: true,
          hasSecret: false,
          active: activeTtsId.value === 'tts-edge',
          settings: {
            voice: vs.edgeVoice.value,
            rate: vs.edgeRate.value,
            pitch: vs.edgePitchHz.value,
          },
          voice: vs.edgeVoice.value,
        },
        {
          id: 'stt-browser',
          kind: 'stt',
          provider: 'browser',
          label: t('settings.voice.presetBrowserSttLabel'),
          isBuiltin: true,
          hasSecret: false,
          active: activeSttId.value === 'stt-browser',
          settings: {},
        },
      ]

      for (const row of ttsData.providers) {
        const connection = makeTtsConnection(row.provider, row.settings, row.secrets?.apiKey === '[stored]')
        const existingBuiltIn = newConnections.find(c => c.id === connection.id)
        if (existingBuiltIn) {
          Object.assign(existingBuiltIn, connection, { isBuiltin: existingBuiltIn.isBuiltin })
        } else {
          newConnections.push(connection)
        }
      }

      for (const row of sttData.providers) {
        newConnections.push(makeSttConnection(row.provider, row.settings, row.secrets?.apiKey === '[stored]'))
      }

      connections.value = newConnections.map(connection => ({
        ...connection,
        active: connection.kind === 'tts'
          ? connection.id === activeTtsId.value
          : connection.id === activeSttId.value,
      }))
    } finally {
      loading.value = false
    }
  }

  async function setActiveConnection(kind: VoiceApiKind, id: string) {
    const connection = connections.value.find(c => c.kind === kind && c.id === id)
    if (!connection) return

    if (kind === 'tts') {
      applyTtsConnectionToLegacyState(connection)
    } else {
      applySttConnectionToLegacyState(connection)
      if (isSttProvider(connection.provider)) {
        await saveActiveSttProvider(connection.provider)
      }
    }

    connections.value = connections.value.map(c => ({
      ...c,
      active: c.kind === kind ? c.id === id : c.active,
    }))
  }

  async function saveConnection(kind: VoiceApiKind, provider: VoiceApiProvider, payload: VoiceApiSavePayload) {
    if (kind === 'tts') {
      if (!isStoredTtsProvider(provider)) throw new Error(`Unsupported TTS provider: ${String(provider)}`)
      const res = await saveTtsSettings(provider, {
        settings: payload.settings as TtsStoredSettings | undefined,
        secrets: payload.secrets as TtsStoredSecretsInput | undefined,
      })
      await refresh()
      await setActiveConnection('tts', `tts-${provider}`)
      return res
    }

    if (provider === 'browser') {
      await saveActiveSttProvider('browser')
      stt.setProvider('browser')
      await refresh()
      return null
    }

    if (!isStoredSttProvider(provider)) throw new Error(`Unsupported STT provider: ${String(provider)}`)
    const res = await saveSttSettings(provider, {
      settings: payload.settings as SttStoredSettings | undefined,
      secrets: payload.secrets as SttStoredSecretsInput | undefined,
      activeProvider: provider,
    })
    await refresh()
    await setActiveConnection('stt', `stt-${provider}`)
    return res
  }

  async function deleteSecret(kind: VoiceApiKind, provider: VoiceApiProvider) {
    if (kind === 'tts') {
      if (!isStoredTtsProvider(provider)) return
      await clearTtsSecret(provider, 'apiKey')
    } else {
      if (!isStoredSttProvider(provider)) return
      await clearSttSecret(provider, 'apiKey')
    }
    await refresh()
  }

  return {
    connections,
    ttsConnections,
    sttConnections,
    activeTtsId,
    activeSttId,
    activeTtsConnection,
    activeSttConnection,
    ttsConnectionOptions,
    sttConnectionOptions,
    loading,
    refresh,
    setActiveConnection,
    saveConnection,
    deleteSecret,
  }
}

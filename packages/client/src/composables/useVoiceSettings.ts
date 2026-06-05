import { ref, watch } from 'vue'
import type { TtsProviderSettingsResponse } from '@/api/hermes/tts-settings'

export type TtsProvider = 'webspeech' | 'openai' | 'custom' | 'edge' | 'mimo'
export type MimoAuthMode = 'api-key' | 'bearer' | 'both'

export interface VoiceSettingsData {
  provider: TtsProvider

  // WebSpeech
  webspeechVoice: string

  // OpenAI
  openaiApiKey: string
  openaiBaseUrl: string
  openaiModel: string
  openaiVoice: string

  // Custom endpoint (OpenAI-compatible)
  customUrl: string
  customApiKey: string

  // Edge TTS
  edgeUrl: string
  edgeVoice: string
  edgeRate: number    // 语速倍率 0.5~2.0，1.0 = 正常
  edgePitchHz: number // 音调偏移 Hz，-20~20，0 = 正常

  // MiMo TTS
  mimoApiKey: string
  mimoAuthMode: MimoAuthMode
  mimoBaseUrl: string
  mimoModel: string            // 'mimo-v2.5-tts' | 'mimo-v2.5-tts-voicedesign' | 'mimo-v2.5-tts-voiceclone'
  mimoVoice: string            // 预置音色 ID
  mimoVoiceDesignDesc: string  // 音色设计描述文本
  mimoVoiceCloneDataUri: string // 音色复刻参考音频 data URI (pending upload only; never persisted)
  mimoVoiceCloneFileName: string
  mimoVoiceCloneFormat: 'mp3' | 'wav'
  mimoStylePrompt: string      // 风格指令
}

const STORAGE_KEY = 'hermes-tts-settings-v2'
const SECRET_STORAGE_KEYS = ['openaiApiKey', 'customApiKey', 'mimoApiKey', 'mimoVoiceCloneDataUri'] as const

const DEFAULT: VoiceSettingsData = {
  provider: 'webspeech',

  webspeechVoice: '',

  openaiApiKey: '',
  openaiBaseUrl: '',
  openaiModel: 'tts-1',
  openaiVoice: 'alloy',

  customUrl: '',
  customApiKey: '',

  edgeUrl: '',
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
  edgeRate: 1.0,
  edgePitchHz: 0,

  mimoApiKey: '',
  mimoAuthMode: 'bearer',
  mimoBaseUrl: 'https://api.xiaomimimo.com/v1',
  mimoModel: 'mimo-v2.5-tts',
  mimoVoice: '冰糖',
  mimoVoiceDesignDesc: '',
  mimoVoiceCloneDataUri: '',
  mimoVoiceCloneFileName: '',
  mimoVoiceCloneFormat: 'wav',
  mimoStylePrompt: '',
}

function stripPersistedSecrets<T extends Record<string, unknown>>(value: T): T {
  for (const key of SECRET_STORAGE_KEYS) {
    delete value[key]
  }
  return value
}

function persistedData(): Omit<VoiceSettingsData, 'openaiApiKey' | 'customApiKey' | 'mimoApiKey' | 'mimoVoiceCloneDataUri'> {
  return {
    provider: provider.value,
    webspeechVoice: webspeechVoice.value,
    openaiBaseUrl: openaiBaseUrl.value,
    openaiModel: openaiModel.value,
    openaiVoice: openaiVoice.value,
    customUrl: customUrl.value,
    edgeUrl: edgeUrl.value,
    edgeVoice: edgeVoice.value,
    edgeRate: edgeRate.value,
    edgePitchHz: edgePitchHz.value,
    mimoAuthMode: mimoAuthMode.value,
    mimoBaseUrl: mimoBaseUrl.value,
    mimoModel: mimoModel.value,
    mimoVoice: mimoVoice.value,
    mimoVoiceDesignDesc: mimoVoiceDesignDesc.value,
    mimoVoiceCloneFileName: mimoVoiceCloneFileName.value,
    mimoVoiceCloneFormat: mimoVoiceCloneFormat.value,
    mimoStylePrompt: mimoStylePrompt.value,
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedData()))
  } catch (err) {
    console.warn('[useVoiceSettings] Failed to persist voice settings:', err)
  }
}

function migrateOldKeys() {
  const oldKey = 'hermes-tts-settings'
  try {
    const old = localStorage.getItem(oldKey)
    if (old) {
      const parsed = stripPersistedSecrets(JSON.parse(old))
      // Old 'custom' provider maps to new 'custom'
      // Old 'gptsovits' provider maps to new 'custom'
      if (parsed.provider === 'gptsovits') {
        parsed.provider = 'custom'
        // old gptsovitsUrl -> customUrl
        if (parsed.gptsovitsUrl && !parsed.customUrl) {
          parsed.customUrl = parsed.gptsovitsUrl
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stripPersistedSecrets({ ...DEFAULT, ...parsed })))
      localStorage.removeItem(oldKey)
    }
  } catch { /* ignore */ }
}

function sanitize(data: VoiceSettingsData): VoiceSettingsData {
  // Clear old Edge TTS adapter URLs — now uses internal node-edge-tts
  if (data.edgeUrl && data.edgeUrl !== '') {
    data.edgeUrl = ''
  }
  if (data.mimoAuthMode !== 'api-key' && data.mimoAuthMode !== 'bearer' && data.mimoAuthMode !== 'both') {
    data.mimoAuthMode = DEFAULT.mimoAuthMode
  }
  if (data.mimoVoiceCloneFormat !== 'mp3' && data.mimoVoiceCloneFormat !== 'wav') {
    data.mimoVoiceCloneFormat = DEFAULT.mimoVoiceCloneFormat
  }
  data.openaiApiKey = ''
  data.customApiKey = ''
  data.mimoApiKey = ''
  data.mimoVoiceCloneDataUri = ''
  return data
}

function load(): VoiceSettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = stripPersistedSecrets(JSON.parse(raw))
      const data = sanitize({ ...DEFAULT, ...parsed })
      // Purge legacy secrets if an older build wrote them.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stripPersistedSecrets({ ...parsed })))
      return data
    }
  } catch { /* ignore */ }
  return { ...DEFAULT }
}

// Run migration once on import
migrateOldKeys()

const initial = load()

// ── Reactive state ──
const provider = ref<TtsProvider>(initial.provider)

// WebSpeech
const webspeechVoice = ref<string>(initial.webspeechVoice)

// OpenAI
const openaiApiKey = ref<string>('') // pending new secret; never persisted
const openaiApiKeyPreview = ref<string>('')
const openaiBaseUrl = ref<string>(initial.openaiBaseUrl)
const openaiModel = ref<string>(initial.openaiModel)
const openaiVoice = ref<string>(initial.openaiVoice)

// Custom
const customUrl = ref<string>(initial.customUrl)
const customApiKey = ref<string>('') // pending new secret; never persisted
const customApiKeyPreview = ref<string>('')

// Edge TTS
const edgeUrl = ref<string>(initial.edgeUrl)
const edgeVoice = ref<string>(initial.edgeVoice)
const edgeRate = ref<number>(initial.edgeRate)
const edgePitchHz = ref<number>(initial.edgePitchHz)

// MiMo TTS
const mimoApiKey = ref<string>('') // pending new secret; never persisted
const mimoApiKeyPreview = ref<string>('')
const mimoAuthMode = ref<MimoAuthMode>(initial.mimoAuthMode)
const mimoBaseUrl = ref<string>(initial.mimoBaseUrl)
const mimoModel = ref<string>(initial.mimoModel)
const mimoVoice = ref<string>(initial.mimoVoice)
const mimoVoiceDesignDesc = ref<string>(initial.mimoVoiceDesignDesc)
const mimoVoiceCloneDataUri = ref<string>('') // pending new secret; never persisted
const mimoVoiceCloneFileName = ref<string>(initial.mimoVoiceCloneFileName)
const mimoVoiceCloneFormat = ref<'mp3' | 'wav'>(initial.mimoVoiceCloneFormat)
const mimoStylePrompt = ref<string>(initial.mimoStylePrompt)

const openaiHasApiKey = ref(false)
const customHasApiKey = ref(false)
const mimoHasApiKey = ref(false)
const mimoHasVoiceCloneData = ref(false)

// Auto-persist on non-secret changes. Secret refs intentionally omitted.
watch(
  [provider, webspeechVoice, openaiBaseUrl, openaiModel, openaiVoice,
   customUrl, edgeUrl, edgeVoice, edgeRate, edgePitchHz,
   mimoAuthMode, mimoBaseUrl, mimoModel, mimoVoice, mimoVoiceDesignDesc,
   mimoVoiceCloneFileName, mimoVoiceCloneFormat, mimoStylePrompt],
  persist,
)

function applyServerTtsSettings(rows: TtsProviderSettingsResponse[]) {
  for (const row of rows) {
    if (row.provider === 'openai') {
      openaiBaseUrl.value = typeof row.settings.baseUrl === 'string' ? row.settings.baseUrl : openaiBaseUrl.value
      openaiModel.value = typeof row.settings.model === 'string' ? row.settings.model : openaiModel.value
      openaiVoice.value = typeof row.settings.voice === 'string' ? row.settings.voice : openaiVoice.value
      openaiApiKeyPreview.value = row.secrets.apiKey || ''
      openaiHasApiKey.value = Boolean(row.secrets.apiKey)
      openaiApiKey.value = ''
    }
    if (row.provider === 'custom') {
      customUrl.value = typeof row.settings.baseUrl === 'string' ? row.settings.baseUrl : customUrl.value
      customApiKeyPreview.value = row.secrets.apiKey || ''
      customHasApiKey.value = Boolean(row.secrets.apiKey)
      customApiKey.value = ''
    }
    if (row.provider === 'edge') {
      edgeVoice.value = typeof row.settings.voice === 'string' ? row.settings.voice : edgeVoice.value
    }
    if (row.provider === 'mimo') {
      mimoBaseUrl.value = typeof row.settings.baseUrl === 'string' ? row.settings.baseUrl : mimoBaseUrl.value
      mimoAuthMode.value = (row.settings.authMode === 'api-key' || row.settings.authMode === 'bearer' || row.settings.authMode === 'both') ? row.settings.authMode : mimoAuthMode.value
      mimoModel.value = typeof row.settings.model === 'string' ? row.settings.model : mimoModel.value
      mimoVoice.value = typeof row.settings.voice === 'string' ? row.settings.voice : mimoVoice.value
      mimoVoiceDesignDesc.value = typeof row.settings.voiceDesignDesc === 'string' ? row.settings.voiceDesignDesc : mimoVoiceDesignDesc.value
      mimoVoiceCloneFormat.value = row.settings.voiceCloneFormat === 'mp3' || row.settings.voiceCloneFormat === 'wav' ? row.settings.voiceCloneFormat : mimoVoiceCloneFormat.value
      mimoStylePrompt.value = typeof row.settings.stylePrompt === 'string' ? row.settings.stylePrompt : mimoStylePrompt.value
      mimoApiKeyPreview.value = row.secrets.apiKey || ''
      mimoHasApiKey.value = Boolean(row.secrets.apiKey)
      mimoHasVoiceCloneData.value = Boolean(row.secrets.voiceCloneDataUri)
      if (row.secrets.voiceCloneFileName) {
        mimoVoiceCloneFileName.value = row.secrets.voiceCloneFileName === '[stored]'
          ? mimoVoiceCloneFileName.value
          : row.secrets.voiceCloneFileName
      }
      mimoApiKey.value = ''
      mimoVoiceCloneDataUri.value = ''
    }
  }
}

export function useVoiceSettings() {
  return {
    provider,
    webspeechVoice,
    openaiApiKey,
    openaiApiKeyPreview,
    openaiHasApiKey,
    openaiBaseUrl,
    openaiModel,
    openaiVoice,
    customUrl,
    customApiKey,
    customApiKeyPreview,
    customHasApiKey,
    edgeUrl,
    edgeVoice,
    edgeRate,
    edgePitchHz,
    mimoApiKey,
    mimoApiKeyPreview,
    mimoHasApiKey,
    mimoHasVoiceCloneData,
    mimoAuthMode,
    mimoBaseUrl,
    mimoModel,
    mimoVoice,
    mimoVoiceDesignDesc,
    mimoVoiceCloneDataUri,
    mimoVoiceCloneFileName,
    mimoVoiceCloneFormat,
    mimoStylePrompt,

    setProvider(v: TtsProvider) { provider.value = v },
    setWebSpeechVoice(v: string) { webspeechVoice.value = v },
    setOpenaiApiKey(v: string) { openaiApiKey.value = v },
    setOpenaiBaseUrl(v: string) { openaiBaseUrl.value = v },
    setOpenaiModel(v: string) { openaiModel.value = v },
    setOpenaiVoice(v: string) { openaiVoice.value = v },
    setCustomUrl(v: string) { customUrl.value = v },
    setCustomApiKey(v: string) { customApiKey.value = v },
    setEdgeUrl(v: string) { edgeUrl.value = v },
    setEdgeVoice(v: string) { edgeVoice.value = v },
    setEdgeRate(v: number) { edgeRate.value = v },
    setEdgePitchHz(v: number) { edgePitchHz.value = v },
    setMimoApiKey(v: string) { mimoApiKey.value = v },
    setMimoAuthMode(v: MimoAuthMode) { mimoAuthMode.value = v },
    setMimoBaseUrl(v: string) { mimoBaseUrl.value = v },
    setMimoModel(v: string) { mimoModel.value = v },
    setMimoVoice(v: string) { mimoVoice.value = v },
    setMimoVoiceDesignDesc(v: string) { mimoVoiceDesignDesc.value = v },
    setMimoVoiceCloneDataUri(v: string) { mimoVoiceCloneDataUri.value = v },
    setMimoVoiceCloneFileName(v: string) { mimoVoiceCloneFileName.value = v },
    setMimoVoiceCloneFormat(v: 'mp3' | 'wav') { mimoVoiceCloneFormat.value = v },
    setMimoStylePrompt(v: string) { mimoStylePrompt.value = v },
    applyServerTtsSettings,

    reset() {
      provider.value = DEFAULT.provider
      webspeechVoice.value = DEFAULT.webspeechVoice
      openaiApiKey.value = ''
      openaiApiKeyPreview.value = ''
      openaiHasApiKey.value = false
      openaiBaseUrl.value = DEFAULT.openaiBaseUrl
      openaiModel.value = DEFAULT.openaiModel
      openaiVoice.value = DEFAULT.openaiVoice
      customUrl.value = DEFAULT.customUrl
      customApiKey.value = ''
      customApiKeyPreview.value = ''
      customHasApiKey.value = false
      edgeUrl.value = DEFAULT.edgeUrl
      edgeVoice.value = DEFAULT.edgeVoice
      edgeRate.value = DEFAULT.edgeRate
      edgePitchHz.value = DEFAULT.edgePitchHz
      mimoApiKey.value = ''
      mimoApiKeyPreview.value = ''
      mimoHasApiKey.value = false
      mimoHasVoiceCloneData.value = false
      mimoAuthMode.value = DEFAULT.mimoAuthMode
      mimoBaseUrl.value = DEFAULT.mimoBaseUrl
      mimoModel.value = DEFAULT.mimoModel
      mimoVoice.value = DEFAULT.mimoVoice
      mimoVoiceDesignDesc.value = DEFAULT.mimoVoiceDesignDesc
      mimoVoiceCloneDataUri.value = ''
      mimoVoiceCloneFileName.value = DEFAULT.mimoVoiceCloneFileName
      mimoVoiceCloneFormat.value = DEFAULT.mimoVoiceCloneFormat
      mimoStylePrompt.value = DEFAULT.mimoStylePrompt
    },
  }
}

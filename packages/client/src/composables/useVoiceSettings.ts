import { ref, watch } from 'vue'

export type TtsProvider = 'webspeech' | 'openai' | 'custom' | 'edge'

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
}

const STORAGE_KEY = 'hermes-tts-settings-v2'

function migrateOldKeys() {
  const oldKey = 'hermes-tts-settings'
  try {
    const old = localStorage.getItem(oldKey)
    if (old) {
      const parsed = JSON.parse(old)
      // Old 'custom' provider maps to new 'custom'
      // Old 'gptsovits' provider maps to new 'custom'
      if (parsed.provider === 'gptsovits') {
        parsed.provider = 'custom'
        // old gptsovitsUrl -> customUrl
        if (parsed.gptsovitsUrl && !parsed.customUrl) {
          parsed.customUrl = parsed.gptsovitsUrl
        }
      }
      // Store as new format
      const data = { ...DEFAULT, ...parsed }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      localStorage.removeItem(oldKey)
    }
  } catch { /* ignore */ }
}

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
}

function sanitize(data: VoiceSettingsData): VoiceSettingsData {
  // Clear old Edge TTS adapter URLs — now uses internal node-edge-tts
  if (data.edgeUrl && data.edgeUrl !== '') {
    data.edgeUrl = ''
  }
  return data
}

function load(): VoiceSettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return sanitize({ ...DEFAULT, ...JSON.parse(raw) })
  } catch { /* ignore */ }
  return { ...DEFAULT }
}

// Run migration once on import
migrateOldKeys()

// ── Reactive state ──
const provider = ref<TtsProvider>(load().provider)

// WebSpeech
const webspeechVoice = ref<string>(load().webspeechVoice)

// OpenAI
const openaiApiKey = ref<string>(load().openaiApiKey)
const openaiBaseUrl = ref<string>(load().openaiBaseUrl)
const openaiModel = ref<string>(load().openaiModel)
const openaiVoice = ref<string>(load().openaiVoice)

// Custom
const customUrl = ref<string>(load().customUrl)
const customApiKey = ref<string>(load().customApiKey)

// Edge TTS
const edgeUrl = ref<string>(load().edgeUrl)
const edgeVoice = ref<string>(load().edgeVoice)

// Auto-persist on change
watch(
  [provider, webspeechVoice, openaiApiKey, openaiBaseUrl, openaiModel, openaiVoice,
   customUrl, customApiKey, edgeUrl, edgeVoice],
  () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      provider: provider.value,
      webspeechVoice: webspeechVoice.value,
      openaiApiKey: openaiApiKey.value,
      openaiBaseUrl: openaiBaseUrl.value,
      openaiModel: openaiModel.value,
      openaiVoice: openaiVoice.value,
      customUrl: customUrl.value,
      customApiKey: customApiKey.value,
      edgeUrl: edgeUrl.value,
      edgeVoice: edgeVoice.value,
    }))
  },
)

export function useVoiceSettings() {
  return {
    provider,
    webspeechVoice,
    openaiApiKey,
    openaiBaseUrl,
    openaiModel,
    openaiVoice,
    customUrl,
    customApiKey,
    edgeUrl,
    edgeVoice,

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

    reset() {
      provider.value = DEFAULT.provider
      webspeechVoice.value = DEFAULT.webspeechVoice
      openaiApiKey.value = DEFAULT.openaiApiKey
      openaiBaseUrl.value = DEFAULT.openaiBaseUrl
      openaiModel.value = DEFAULT.openaiModel
      openaiVoice.value = DEFAULT.openaiVoice
      customUrl.value = DEFAULT.customUrl
      customApiKey.value = DEFAULT.customApiKey
      edgeUrl.value = DEFAULT.edgeUrl
      edgeVoice.value = DEFAULT.edgeVoice
    },
  }
}

import type { VoiceApiPreset } from '@/types/voice-api'

export const VOICE_API_PRESETS: VoiceApiPreset[] = [
  // TTS Presets
  {
    id: 'tts-edge',
    kind: 'tts',
    provider: 'edge',
    label: 'Edge TTS',
    labelKey: 'settings.voice.presetEdgeTtsLabel',
    description: 'Free high-quality cloud voices from Microsoft Edge.',
    descriptionKey: 'settings.voice.presetEdgeTtsDescription',
    isBuiltin: true,
    isSecretRequired: false,
    capabilities: {
      voices: true,
      rate: true,
      pitch: true,
    },
  },
  {
    id: 'tts-openai',
    kind: 'tts',
    provider: 'openai',
    label: 'OpenAI TTS',
    labelKey: 'settings.voice.presetOpenaiTtsLabel',
    baseUrl: 'https://api.openai.com/v1/audio/speech',
    defaultModel: 'tts-1',
    isSecretRequired: true,
    capabilities: {
      models: true,
      voices: true,
    },
  },
  {
    id: 'tts-mimo',
    kind: 'tts',
    provider: 'mimo',
    label: 'MiMo TTS',
    labelKey: 'settings.voice.presetMimoTtsLabel',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-tts',
    isSecretRequired: true,
    capabilities: {
      models: true,
      voices: true,
      stylePrompt: true,
      voiceDesign: true,
      voiceClone: true,
    },
  },
  {
    id: 'tts-custom',
    kind: 'tts',
    provider: 'custom',
    label: 'Custom TTS',
    labelKey: 'settings.voice.presetCustomTtsLabel',
    isSecretRequired: true,
    capabilities: {
      models: true,
    },
  },

  // STT Presets
  {
    id: 'stt-browser',
    kind: 'stt',
    provider: 'browser',
    label: 'Browser STT',
    labelKey: 'settings.voice.presetBrowserSttLabel',
    description: 'Native browser speech recognition API.',
    descriptionKey: 'settings.voice.presetBrowserSttDescription',
    isBuiltin: true,
    isSecretRequired: false,
    capabilities: {},
  },
  {
    id: 'stt-openai',
    kind: 'stt',
    provider: 'openai',
    label: 'OpenAI Whisper',
    labelKey: 'settings.voice.presetOpenaiWhisperLabel',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'whisper-1',
    isSecretRequired: true,
    capabilities: {
      models: true,
    },
  },
  {
    id: 'stt-groq',
    kind: 'stt',
    provider: 'custom', // Groq uses Custom STT storage with specific URL
    label: 'Groq STT',
    labelKey: 'settings.voice.presetGroqSttLabel',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'whisper-large-v3',
    isSecretRequired: true,
    capabilities: {
      models: true,
    },
  },
  {
    id: 'stt-custom',
    kind: 'stt',
    provider: 'custom',
    label: 'Custom STT',
    labelKey: 'settings.voice.presetCustomSttLabel',
    isSecretRequired: true,
    capabilities: {
      models: true,
    },
  },
]

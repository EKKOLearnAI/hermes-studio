import { describe, expect, it } from 'vitest'
import { VOICE_API_PRESETS } from '@/constants/voiceApiPresets'

describe('Custom TTS voice capability', () => {
  it('declares the voices capability so the Voice field renders for Custom TTS', () => {
    const preset = VOICE_API_PRESETS.find(entry => entry.id === 'tts-custom')
    expect(preset).toBeDefined()
    expect(preset?.capabilities?.voices).toBe(true)
  })

  it('keeps the models capability for Custom TTS', () => {
    const preset = VOICE_API_PRESETS.find(entry => entry.id === 'tts-custom')
    expect(preset?.capabilities?.models).toBe(true)
  })

  it('does not add a voice capability to Custom STT', () => {
    const preset = VOICE_API_PRESETS.find(entry => entry.id === 'stt-custom')
    expect(preset?.capabilities?.voices).toBeUndefined()
  })

  it('declares voices for every selectable TTS preset', () => {
    const selectableTts = VOICE_API_PRESETS.filter(entry => entry.kind === 'tts' && !entry.isBuiltin)
    const missing = selectableTts.filter(entry => !entry.capabilities?.voices).map(entry => entry.id)
    expect(missing).toEqual([])
  })

  it('exposes both MiniMax TTS regions with the 2.8 default model', () => {
    const presets = VOICE_API_PRESETS.filter(entry => entry.provider === 'minimax')
    expect(presets.map(entry => entry.baseUrl).sort()).toEqual([
      'https://api.minimax.io/v1/t2a_v2',
      'https://api.minimaxi.com/v1/t2a_v2',
    ])
    expect(presets.every(entry => entry.defaultModel === 'speech-2.8-hd')).toBe(true)
  })
})

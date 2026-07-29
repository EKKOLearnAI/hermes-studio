import { describe, expect, it } from 'vitest'
import { EDGE_TTS_VOICE_OPTIONS } from '@/constants/edgeTtsVoices'

describe('EDGE_TTS_VOICE_OPTIONS', () => {
  it('keeps the previously offered Chinese and English voices', () => {
    const values = EDGE_TTS_VOICE_OPTIONS.map(option => option.value)
    expect(values).toEqual(expect.arrayContaining([
      'zh-CN-XiaoxiaoNeural',
      'zh-CN-XiaoxuanNeural',
      'zh-CN-YunxiNeural',
      'zh-CN-YunjianNeural',
      'zh-CN-YunyangNeural',
      'en-US-JennyNeural',
      'en-US-AriaNeural',
      'en-US-GuyNeural',
    ]))
  })

  it('offers Arabic voices', () => {
    const values = EDGE_TTS_VOICE_OPTIONS.map(option => option.value)
    expect(values).toContain('ar-SA-HamedNeural')
    expect(values).toContain('ar-SA-ZariyahNeural')
  })

  it('covers more than one language family', () => {
    const locales = new Set(EDGE_TTS_VOICE_OPTIONS.map(option => option.value.split('-').slice(0, 2).join('-')))
    expect(locales.size).toBeGreaterThan(2)
  })

  it('has no duplicate values and labels every option', () => {
    const values = EDGE_TTS_VOICE_OPTIONS.map(option => option.value)
    expect(new Set(values).size).toBe(values.length)
    expect(EDGE_TTS_VOICE_OPTIONS.every(option => option.label.trim().length > 0)).toBe(true)
  })

  it('uses well-formed Edge voice ids', () => {
    for (const option of EDGE_TTS_VOICE_OPTIONS) {
      expect(option.value).toMatch(/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/)
    }
  })
})

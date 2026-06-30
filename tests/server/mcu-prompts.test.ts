import { stat } from 'fs/promises'
import { describe, expect, it } from 'vitest'

import {
  MCU_PROMPTS,
  MCU_TTS_SAMPLE_RATE,
  isValidMcuAudioFileName,
  mcuPromptFileName,
  mcuPromptText,
  mcuPromptUrl,
  resolveMcuAudioPath,
  type McuPromptId,
} from '../../packages/server/src/services/hermes/mcu-prompts'

describe('mcu prompts', () => {
  it('serves bundled 24k prompt assets through local MCU audio URLs', async () => {
    expect(MCU_TTS_SAMPLE_RATE).toBe(24000)

    for (const id of Object.keys(MCU_PROMPTS) as McuPromptId[]) {
      const fileName = mcuPromptFileName(id)
      expect(fileName).toMatch(/-24k\.s16le\.pcm$/)
      expect(mcuPromptUrl(id)).toBe(`/api/hermes/mcu/audio/${fileName}`)
      expect(mcuPromptText(id)).toBeTruthy()
      expect(isValidMcuAudioFileName(fileName)).toBe(true)

      const resolved = await resolveMcuAudioPath(fileName)
      expect(resolved?.bundled).toBe(true)
      expect(resolved?.path).toContain('mcu-prompts')

      const info = await stat(resolved!.path)
      expect(info.size).toBeGreaterThan(0)
      expect(info.size % 2).toBe(0)
    }
  })
})

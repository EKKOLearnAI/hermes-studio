import type { OpenaiTtsProviderOptions, TtsProvider } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { textToSpeech } from '../tts'

export const edgeTtsProvider: TtsProvider<OpenaiTtsProviderOptions> = {
  id: 'edge',
  async synthesize(req, opts) {
    const text = clampTtsText(cleanTtsText(req.text))

    if (!text) {
      throw new Error('Edge TTS text is empty after cleaning')
    }

    const { audio, engine } = await textToSpeech({
      text,
      voice: opts.voice,
      rate: opts.rate,
      pitch: opts.pitch,
    })

    return {
      audio,
      contentType: 'audio/mpeg',
      engine,
      provider: 'edge',
    }
  },
}

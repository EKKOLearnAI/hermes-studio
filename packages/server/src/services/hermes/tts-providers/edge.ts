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

    const { audio, engine } = await withAbortSignal(
      () => textToSpeech({
        text,
        voice: opts.voice,
        rate: opts.rate,
        pitch: opts.pitch,
      }),
      req.signal,
    )

    return {
      audio,
      contentType: 'audio/mpeg',
      engine,
      provider: 'edge',
    }
  },
}

async function withAbortSignal<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return run()
  }

  if (signal.aborted) {
    throw createAbortError()
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError())
    }

    signal.addEventListener('abort', onAbort, { once: true })

    run().then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError')
  }

  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

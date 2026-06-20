import type { OpenaiTtsProviderOptions, TtsProvider } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { textToSpeech } from '../tts'

function edgeOutputFormat(opts: OpenaiTtsProviderOptions): { outputFormat?: string; contentType: string } {
  const format = String(opts.format || '').trim().toLowerCase()
  if (format === 'pcm' || format === 'raw' || format === 's16le') {
    // Edge raw PCM synthesis can hang with node-edge-tts. Return MP3 and let
    // MCU callers transcode it to PCM with ffmpeg.
    return {
      outputFormat: undefined,
      contentType: 'audio/mpeg',
    }
  }
  return { contentType: 'audio/mpeg' }
}

export const edgeTtsProvider: TtsProvider<OpenaiTtsProviderOptions> = {
  id: 'edge',
  async synthesize(req, opts) {
    const text = clampTtsText(cleanTtsText(req.text))

    if (!text) {
      throw new Error('Edge TTS text is empty after cleaning')
    }

    const output = edgeOutputFormat(opts)
    const { audio, engine } = await withAbortSignal(
      () => textToSpeech({
        text,
        voice: opts.voice,
        rate: opts.rate,
        pitch: opts.pitch,
        outputFormat: output.outputFormat,
      }),
      req.signal,
    )

    return {
      audio,
      contentType: output.contentType,
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

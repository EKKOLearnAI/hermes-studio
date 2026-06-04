import type { Context } from 'koa'
import { textToSpeech, openaiCompatibleTts, speedToEdgeRate } from '../../services/hermes/tts'
import { getTtsProvider } from '../../services/hermes/tts-providers'

export async function generate(ctx: Context) {
  const { text, lang } = ctx.request.body as {
    text?: string
    lang?: string
  }

  if (!text || typeof text !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'text is required' }
    return
  }

  if (text.length > 5000) {
    ctx.status = 400
    ctx.body = { error: 'text is too long (max 5000 characters)' }
    return
  }

  const { audio, engine } = await textToSpeech({ text, lang })

  ctx.set('Content-Type', 'audio/mpeg')
  ctx.set('Content-Length', String(audio.length))
  ctx.set('X-TTS-Engine', engine)
  ctx.body = audio
}

export async function synthesize(ctx: Context) {
  const body = ctx.request.body as {
    provider?: string
    text?: string
    options?: unknown
  }

  if (!body.text || typeof body.text !== 'string' || !body.text.trim()) {
    ctx.status = 400
    ctx.body = { error: 'text is required' }
    return
  }

  const options = body.options === undefined ? {} : body.options
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    ctx.status = 400
    ctx.body = { error: 'options must be an object' }
    return
  }

  const provider = getTtsProvider(body.provider || '')
  if (!provider) {
    ctx.status = 400
    ctx.body = { error: 'unknown TTS provider' }
    return
  }

  const controller = new AbortController()
  if (ctx.req?.on) {
    ctx.req.on('close', () => controller.abort())
  }

  try {
    const result = await provider.synthesize(
      { text: body.text, signal: controller.signal },
      options,
    )

    ctx.set('Content-Type', result.contentType)
    ctx.set('Content-Length', String(result.audio.length))
    ctx.set('X-TTS-Engine', result.engine)
    ctx.set('X-TTS-Provider', result.provider)
    ctx.body = result.audio
  } catch (error) {
    if (isAbortError(error)) {
      ctx.status = 499
      ctx.body = { error: 'TTS request aborted' }
      return
    }

    ctx.status = 502
    ctx.body = { error: 'TTS synthesis failed' }
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/**
 * OpenAI-compatible TTS endpoint.
 * Accepts: { model, input, voice, speed }
 * Returns audio/mpeg stream.
 */
export async function openaiProxy(ctx: Context) {
  const body = ctx.request.body as {
    input?: string
    voice?: string
    speed?: number
    model?: string
    rate?: string
    pitch?: string
  }

  if (!body.input || typeof body.input !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'input is required' }
    return
  }

  if (body.input.length > 5000) {
    ctx.status = 400
    ctx.body = { error: 'input is too long (max 5000 characters)' }
    return
  }

  const { audio, engine } = await openaiCompatibleTts({
    input: body.input,
    voice: body.voice,
    speed: body.speed,
    model: body.model,
    rate: body.rate,
    pitch: body.pitch,
  })

  ctx.set('Content-Type', 'audio/mpeg')
  ctx.set('Content-Length', String(audio.length))
  ctx.set('X-TTS-Engine', engine)
  ctx.body = audio
}

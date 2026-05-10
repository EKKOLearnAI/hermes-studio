import type { Context } from 'koa'
import { textToSpeech, openaiCompatibleTts, speedToEdgeRate } from '../../services/hermes/tts'

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
  })

  ctx.set('Content-Type', 'audio/mpeg')
  ctx.set('Content-Length', String(audio.length))
  ctx.set('X-TTS-Engine', engine)
  ctx.body = audio
}

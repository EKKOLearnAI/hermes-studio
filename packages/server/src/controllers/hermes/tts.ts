import type { Context } from 'koa'
import { textToSpeech, openaiCompatibleTts } from '../../services/hermes/tts'
import { getTtsProvider } from '../../services/hermes/tts-providers'
import {
  assertStoredTtsProvider,
  clearTtsProviderSecret,
  getTtsProviderConfigForSynthesis,
  listTtsProviderSettings,
  type StoredTtsProvider,
  TtsSettingsValidationError,
  upsertTtsProviderSettings,
} from '../../db/hermes/tts-settings-store'

const CLIENT_SECRET_FIELDS = new Set(['apiKey', 'voiceCloneDataUri', 'voiceCloneFileName'])
const MAX_TTS_ERROR_MESSAGE_LENGTH = 500

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactTtsErrorMessage(message: string, options: Record<string, unknown>): string {
  let redacted = message
  for (const key of CLIENT_SECRET_FIELDS) {
    const value = options[key]
    if (typeof value === 'string' && value.length >= 4) {
      redacted = redacted.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED]')
      const dataUriMatch = /^data:audio\/(?:mpeg|mp3|wav);base64,([A-Za-z0-9+/=]+)$/i.exec(value)
      if (dataUriMatch?.[1] && dataUriMatch[1].length >= 4) {
        redacted = redacted.replace(new RegExp(escapeRegExp(dataUriMatch[1]), 'g'), '[REDACTED]')
      }
    }
  }

  redacted = redacted
    .replace(/Bearer\s+[^\s"'}]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[-_ ]?key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]')
    .replace(/data:audio\/(?:mpeg|mp3|wav);base64,[A-Za-z0-9+/=]+/gi, 'data:audio/[REDACTED]')

  return redacted.length > MAX_TTS_ERROR_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_TTS_ERROR_MESSAGE_LENGTH)}…`
    : redacted
}

function requireAuthenticatedUserId(ctx: Context): number | null {
  const rawUserId = ctx.state.user?.id
  const userId = typeof rawUserId === 'number' ? rawUserId : Number.NaN
  if (!Number.isInteger(userId) || userId <= 0) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return null
  }
  return userId
}

function asOptionsObject(value: unknown): Record<string, unknown> | null {
  if (value === undefined) {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function stripClientSecretFields(options: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (CLIENT_SECRET_FIELDS.has(key)) continue
    sanitized[key] = value
  }
  return sanitized
}

function sanitizeClientPlaybackOptions(
  options: Record<string, unknown>,
  storedConfig: { secrets: Record<string, string> } | null,
): Record<string, unknown> {
  const sanitized = stripClientSecretFields(options)
  if (storedConfig && Object.keys(storedConfig.secrets || {}).length > 0) {
    delete sanitized.baseUrl
  }
  return sanitized
}

function handleTtsSettingsError(ctx: Context, error: unknown): boolean {
  if (error instanceof TtsSettingsValidationError) {
    ctx.status = 400
    ctx.body = { error: error.message }
    return true
  }
  return false
}

export async function listSettings(ctx: Context) {
  const userId = requireAuthenticatedUserId(ctx)
  if (!userId) return

  try {
    ctx.body = {
      settings: listTtsProviderSettings(userId),
    }
  } catch (error) {
    if (handleTtsSettingsError(ctx, error)) return
    throw error
  }
}

export async function saveSettings(ctx: Context) {
  const userId = requireAuthenticatedUserId(ctx)
  if (!userId) return

  const provider = ctx.params.provider || ''
  const body = ctx.request.body as {
    settings?: unknown
    secrets?: unknown
  } | undefined

  try {
    const setting = upsertTtsProviderSettings(userId, assertStoredTtsProvider(provider), {
      settings: body?.settings,
      secrets: body?.secrets,
      preserveExistingSecrets: true,
    })

    ctx.body = { setting }
  } catch (error) {
    if (handleTtsSettingsError(ctx, error)) return
    throw error
  }
}

export async function deleteSecret(ctx: Context) {
  const userId = requireAuthenticatedUserId(ctx)
  if (!userId) return

  const provider = ctx.params.provider || ''
  const secretName = ctx.params.secretName || ''

  try {
    const setting = clearTtsProviderSecret(userId, assertStoredTtsProvider(provider), secretName)
    ctx.body = { success: true, setting }
  } catch (error) {
    if (handleTtsSettingsError(ctx, error)) return
    throw error
  }
}

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
  const userId = requireAuthenticatedUserId(ctx)
  if (!userId) return

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

  const options = asOptionsObject(body.options)
  if (!options) {
    ctx.status = 400
    ctx.body = { error: 'options must be an object' }
    return
  }

  let providerId: StoredTtsProvider
  try {
    providerId = assertStoredTtsProvider(body.provider || '')
  } catch (error) {
    if (handleTtsSettingsError(ctx, error)) return
    throw error
  }

  const provider = getTtsProvider(providerId)
  if (!provider) {
    ctx.status = 400
    ctx.body = { error: 'unknown TTS provider' }
    return
  }

  const controller = new AbortController()
  if (ctx.req?.on) {
    ctx.req.on('close', () => controller.abort())
  }

  let mergedOptions: Record<string, unknown> = {}

  try {
    const storedConfig = getTtsProviderConfigForSynthesis(userId, providerId)
    mergedOptions = {
      ...(storedConfig?.settings || {}),
      ...sanitizeClientPlaybackOptions(options, storedConfig),
      ...(storedConfig?.secrets || {}),
    }

    const result = await provider.synthesize(
      { text: body.text, signal: controller.signal },
      mergedOptions,
    )

    ctx.set('Content-Type', result.contentType)
    ctx.set('Content-Length', String(result.audio.length))
    ctx.set('X-TTS-Engine', result.engine)
    ctx.set('X-TTS-Provider', result.provider)
    ctx.body = result.audio
  } catch (error) {
    if (handleTtsSettingsError(ctx, error)) {
      return
    }

    if (isAbortError(error)) {
      ctx.status = 499
      ctx.body = { error: 'TTS request aborted' }
      return
    }

    const message = redactTtsErrorMessage(getErrorMessage(error), mergedOptions)
    ctx.status = 502
    ctx.body = { error: message ? `TTS synthesis failed: ${message}` : 'TTS synthesis failed' }
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

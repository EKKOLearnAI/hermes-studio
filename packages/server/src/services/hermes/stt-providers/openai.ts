import type { StoredSttProvider } from '../../../db/hermes/stt-settings-store'
import { assertSafeResolvedTtsBaseUrl, normalizeSafeTtsBaseUrl } from '../tts-providers/url-safety'
import type { SttTranscribeInput, SttTranscribeResult } from './types'

export class SttProviderConfigError extends Error {}

export const DEFAULT_OPENAI_STT_URL = 'https://api.openai.com/v1/audio/transcriptions'
export const DEFAULT_MODEL = 'gpt-4o-transcribe'

const MAX_ERROR_DETAIL_LENGTH = 200
const MAX_PROMPT_LENGTH = 1000

function getProviderLabel(provider: StoredSttProvider): string {
  return provider === 'custom' ? 'Custom STT' : 'OpenAI STT'
}

function buildTranscriptionsUrl(baseUrl: string, providerLabel: string): string {
  const normalizedBaseUrl = normalizeSafeTtsBaseUrl(baseUrl, providerLabel)
  const url = new URL(normalizedBaseUrl)
  const search = url.search
  url.hash = ''

  const pathname = url.pathname.replace(/\/+$/, '')

  if (!pathname || pathname === '/') {
    return `${url.origin}/audio/transcriptions${search}`
  }

  if (pathname.endsWith('/audio/transcriptions')) {
    return `${url.origin}${pathname}${search}`
  }

  return `${url.origin}${pathname}/audio/transcriptions${search}`
}

function resolveBaseUrl(input: SttTranscribeInput): string {
  if (input.provider === 'custom') {
    const baseUrl = String(input.settings.baseUrl || '').trim()
    if (!baseUrl) {
      throw new SttProviderConfigError('Custom STT baseUrl is required')
    }
    return buildTranscriptionsUrl(baseUrl, getProviderLabel(input.provider))
  }

  return DEFAULT_OPENAI_STT_URL
}

function requireApiKey(input: SttTranscribeInput): string {
  const apiKey = String(input.secrets.apiKey || '').trim()
  if (!apiKey) {
    throw new SttProviderConfigError('OpenAI-compatible STT API key is required')
  }
  return apiKey
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim()
  return trimmed || undefined
}

function sanitizeDetail(detail: string, apiKey: string): string {
  const normalized = String(detail || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  return normalized.replaceAll(apiKey, '[redacted]').slice(0, MAX_ERROR_DETAIL_LENGTH)
}

export async function transcribeOpenAiCompatible(input: SttTranscribeInput): Promise<SttTranscribeResult> {
  const startedAt = Date.now()
  const apiKey = requireApiKey(input)

  if (!Buffer.isBuffer(input.audio) || input.audio.length === 0) {
    throw new Error('OpenAI-compatible STT audio is empty')
  }

  const baseUrl = resolveBaseUrl(input)
  const model = trimOptional(input.settings.model) || DEFAULT_MODEL
  const language = trimOptional(input.settings.language)
  const prompt = trimOptional(input.settings.prompt)?.slice(0, MAX_PROMPT_LENGTH)

  await assertSafeResolvedTtsBaseUrl(new URL(baseUrl), getProviderLabel(input.provider))

  const form = new FormData()
  const audioBytes = Uint8Array.from(input.audio)
  form.append('file', new Blob([audioBytes], { type: trimOptional(input.mimeType) || 'application/octet-stream' }), trimOptional(input.fileName) || 'audio')
  form.append('model', model)
  if (language) {
    form.append('language', language)
  }
  if (prompt) {
    form.append('prompt', prompt)
  }

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
    redirect: 'manual',
    signal: input.signal,
  })

  if (!response.ok) {
    const detail = sanitizeDetail(await response.text().catch(() => response.statusText || ''), apiKey)
    throw new Error(`OpenAI-compatible STT returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }

  const payload = await response.json() as { text?: unknown }
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text) {
    throw new Error('OpenAI-compatible STT response text is empty')
  }

  return {
    text,
    provider: input.provider,
    model,
    language,
    durationMs: Date.now() - startedAt,
  }
}

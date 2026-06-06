import type { MimoTtsProviderOptions, MimoTtsProvider } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { assertSafeResolvedTtsBaseUrl, normalizeSafeTtsBaseUrl } from './url-safety'

export const MAX_MIMO_VOICE_CLONE_AUDIO_BYTES = 10 * 1024 * 1024

function normalizeBaseUrl(baseUrl: string): string {
  return normalizeSafeTtsBaseUrl(baseUrl, 'MiMo').replace(/\/+$/, '')
}

function buildHeaders(opts: MimoTtsProviderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const authMode = opts.authMode ?? 'bearer'

  if (authMode === 'bearer' || authMode === 'both') {
    headers.Authorization = `Bearer ${opts.apiKey}`
  }

  if (authMode === 'api-key' || authMode === 'both') {
    headers['api-key'] = opts.apiKey
  }

  return headers
}

function inferVoiceMode(opts: MimoTtsProviderOptions) {
  if (opts.voiceMode) {
    return opts.voiceMode
  }

  if (opts.model === 'mimo-v2.5-tts-voicedesign') {
    return 'voiceDesign'
  }

  if (opts.model === 'mimo-v2.5-tts-voiceclone') {
    return 'voiceClone'
  }

  return 'preset'
}

function estimateBase64DecodedBytes(base64: string): number {
  const trimmed = base64.trim()
  if (!trimmed) return 0
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0
  return Math.floor((trimmed.length * 3) / 4) - padding
}

function parseMimoVoiceCloneDataUri(dataUri: string): string {
  const match = /^data:audio\/(?:mpeg|mp3|wav);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUri)
  if (!match) {
    throw new Error('MiMo TTS voiceCloneDataUri must be an mp3 or wav data URI')
  }

  if (estimateBase64DecodedBytes(match[1]) > MAX_MIMO_VOICE_CLONE_AUDIO_BYTES) {
    throw new Error('MiMo TTS voiceCloneDataUri must be 10 MiB or smaller')
  }

  return match[1]
}

export function validateMimoVoiceCloneDataUri(dataUri: string) {
  parseMimoVoiceCloneDataUri(dataUri)
}

function buildMessages(text: string, opts: MimoTtsProviderOptions) {
  const mode = inferVoiceMode(opts)

  const userContent = mode === 'voiceDesign'
    ? [opts.voiceDesignDesc || '', opts.stylePrompt || ''].filter(Boolean).join('\n\n')
    : opts.stylePrompt || ''

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (userContent) {
    messages.push({ role: 'user', content: userContent })
  }
  messages.push({ role: 'assistant', content: text })
  return messages
}

function buildAudio(opts: MimoTtsProviderOptions): Record<string, string> {
  const mode = inferVoiceMode(opts)
  const audio: Record<string, string> = {
    format: 'wav',
  }

  if (mode === 'preset' && opts.voice) {
    audio.voice = opts.voice
  }

  if (mode === 'voiceClone') {
    if (!opts.voiceCloneDataUri) {
      throw new Error('MiMo TTS voiceCloneDataUri is required for voiceClone mode')
    }
    audio.voice = parseMimoVoiceCloneDataUri(opts.voiceCloneDataUri)
  }

  return audio
}

export const mimoTtsProvider: MimoTtsProvider = {
  id: 'mimo',
  async synthesize(req, opts) {
    const baseUrl = normalizeBaseUrl(opts.baseUrl)
    const text = clampTtsText(cleanTtsText(req.text))

    if (!text) {
      throw new Error('MiMo TTS text is empty after cleaning')
    }

    const messages = buildMessages(text, opts)
    const audio = buildAudio(opts)
    await assertSafeResolvedTtsBaseUrl(new URL(baseUrl), 'MiMo')

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(opts),
      body: JSON.stringify({
        model: opts.model,
        messages,
        audio,
      }),
      redirect: 'manual',
      signal: req.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`MiMo TTS returned ${res.status}: ${body || res.statusText}`)
    }

    const json = await res.json()
    const audioBase64 = json?.choices?.[0]?.message?.audio?.data
    if (!audioBase64) {
      throw new Error('MiMo TTS response missing audio data')
    }

    return {
      audio: Buffer.from(audioBase64, 'base64'),
      contentType: 'audio/wav',
      engine: 'mimo',
      provider: 'mimo',
    }
  },
}

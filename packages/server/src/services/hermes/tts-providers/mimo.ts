import type { MimoTtsProviderOptions, MimoTtsProvider } from './types'
import { cleanTtsText, clampTtsText } from './text'

function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MiMo TTS baseUrl must use http or https')
  }

  return url.toString().replace(/\/+$/, '')
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
  return opts.voiceMode || (opts.model === 'mimo-v2.5-tts-voicedesign' ? 'voiceDesign' : 'preset')
}

function buildMessages(text: string, opts: MimoTtsProviderOptions) {
  const mode = inferVoiceMode(opts)

  if (mode === 'voiceClone') {
    if (!opts.voiceCloneDataUri) {
      throw new Error('MiMo TTS voiceCloneDataUri is required for voiceClone mode')
    }

    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.stylePrompt || '' },
          {
            type: 'input_audio',
            input_audio: {
              data: opts.voiceCloneDataUri,
              format: 'wav',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: text,
      },
    ]
  }

  const userContent = mode === 'voiceDesign'
    ? [opts.voiceDesignDesc || '', opts.stylePrompt || ''].filter(Boolean).join('\n\n')
    : opts.stylePrompt || ''

  return [
    {
      role: 'user',
      content: userContent,
    },
    {
      role: 'assistant',
      content: text,
    },
  ]
}

function buildAudio(opts: MimoTtsProviderOptions): Record<string, string> {
  const mode = inferVoiceMode(opts)
  const audio: Record<string, string> = {
    format: 'wav',
  }

  if (mode === 'preset' && opts.voice) {
    audio.voice = opts.voice
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

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(opts),
      body: JSON.stringify({
        model: opts.model,
        messages: buildMessages(text, opts),
        audio: buildAudio(opts),
      }),
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

import type { OpenaiTtsProvider, TtsProviderId } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { assertSafeTtsBaseUrl } from './url-safety'

function buildSpeechUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  assertSafeTtsBaseUrl(url, 'OpenAI')

  const search = url.search
  url.hash = ''

  const pathname = url.pathname.replace(/\/+$/, '')

  if (!pathname || pathname === '/') {
    return `${url.origin}/audio/speech${search}`
  }

  if (pathname.endsWith('/audio/speech')) {
    return `${url.origin}${pathname}${search}`
  }

  return `${url.origin}${pathname}/audio/speech${search}`
}

export function createOpenaiCompatibleTtsProvider(
  id: Extract<TtsProviderId, 'openai' | 'custom' | 'deepinfra'>,
  options: { engine?: string; defaultBaseUrl?: string; defaultModel?: string; defaultVoice?: string } = {},
): OpenaiTtsProvider {
  return {
    id,
    async synthesize(req, opts) {
      const baseUrl = String(opts.baseUrl || options.defaultBaseUrl || '').trim()
      if (!baseUrl) {
        throw new Error(`${id} TTS baseUrl is required`)
      }
      const speechUrl = buildSpeechUrl(baseUrl)
      const text = clampTtsText(cleanTtsText(req.text))

      if (!text) {
        throw new Error('OpenAI TTS text is empty after cleaning')
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }

      if (opts.apiKey) {
        headers.Authorization = `Bearer ${opts.apiKey}`
      }

      const res = await fetch(speechUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: opts.model || options.defaultModel || 'tts-1',
          voice: opts.voice || options.defaultVoice || 'alloy',
          input: text,
          ...(opts.rate ? { rate: opts.rate } : {}),
          ...(opts.pitch ? { pitch: opts.pitch } : {}),
          ...(opts.format ? { response_format: opts.format } : {}),
        }),
        signal: req.signal,
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`OpenAI TTS returned ${res.status}: ${body || res.statusText}`)
      }

      return {
        audio: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'audio/mpeg',
        engine: options.engine || id,
        provider: id,
      }
    },
  }
}

export const openaiTtsProvider: OpenaiTtsProvider = createOpenaiCompatibleTtsProvider('openai')
export const customTtsProvider: OpenaiTtsProvider = createOpenaiCompatibleTtsProvider('custom')
export const deepinfraTtsProvider: OpenaiTtsProvider = createOpenaiCompatibleTtsProvider('deepinfra', {
  defaultBaseUrl: 'https://api.deepinfra.com/v1/openai',
  defaultVoice: 'default',
})

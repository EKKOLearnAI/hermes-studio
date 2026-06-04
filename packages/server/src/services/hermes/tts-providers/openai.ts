import type { OpenaiTtsProvider } from './types'
import { cleanTtsText, clampTtsText } from './text'

function buildSpeechUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenAI TTS baseUrl must use http or https')
  }

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

export const openaiTtsProvider: OpenaiTtsProvider = {
  id: 'openai',
  async synthesize(req, opts) {
    const speechUrl = buildSpeechUrl(opts.baseUrl)
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
        model: opts.model || 'tts-1',
        voice: opts.voice || 'alloy',
        input: text,
        ...(opts.rate ? { rate: opts.rate } : {}),
        ...(opts.pitch ? { pitch: opts.pitch } : {}),
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
      engine: 'openai',
      provider: 'openai',
    }
  },
}

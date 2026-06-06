export interface TtsOptions {
  text: string
  lang?: string
  rate?: string   // Edge TTS rate format: "+NN%" or "-NN%"
  pitch?: string  // Edge TTS pitch format: "+NNHz" or "-NNHz"
}

export type TtsProviderId = 'edge' | 'openai' | 'custom' | 'mimo'

export interface SynthesizeSpeechRequest {
  provider: TtsProviderId
  text: string
  options?: Record<string, unknown>
  signal?: AbortSignal
}

async function readTtsError(res: Response): Promise<string> {
  const fallback = `TTS request failed: ${res.status}`
  try {
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const body = await res.json() as { error?: unknown }
      return typeof body.error === 'string' && body.error ? `${fallback}: ${body.error}` : fallback
    }
    const text = await res.text()
    return text ? `${fallback}: ${text}` : fallback
  } catch {
    return fallback
  }
}

export async function generateSpeech(opts: TtsOptions): Promise<{ audio: Blob; engine: string }> {
  const res = await fetch(
    `${localStorage.getItem('hermes_server_url') || ''}/api/hermes/tts`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('hermes_api_key') || ''}`,
      },
      body: JSON.stringify(opts),
    },
  )

  if (!res.ok) {
    throw new Error(await readTtsError(res))
  }

  const audio = await res.blob()
  const engine = res.headers.get('X-TTS-Engine') || 'unknown'
  return { audio, engine }
}

export async function synthesizeSpeech(
  req: SynthesizeSpeechRequest,
): Promise<{ audio: Blob; engine: string; provider: string }> {
  const res = await fetch(
    `${localStorage.getItem('hermes_server_url') || ''}/api/hermes/tts/synthesize`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('hermes_api_key') || ''}`,
      },
      body: JSON.stringify({
        provider: req.provider,
        text: req.text,
        options: req.options || {},
      }),
      signal: req.signal,
    },
  )

  if (!res.ok) {
    throw new Error(await readTtsError(res))
  }

  const audio = await res.blob()
  const engine = res.headers.get('X-TTS-Engine') || 'unknown'
  const provider = res.headers.get('X-TTS-Provider') || req.provider
  return { audio, engine, provider }
}

export function playAudioBlob(blob: Blob): HTMLAudioElement {
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  audio.play()
  audio.onended = () => URL.revokeObjectURL(url)
  return audio
}

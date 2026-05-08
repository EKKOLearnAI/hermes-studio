export interface TtsOptions {
  text: string
  lang?: string
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
    throw new Error(`TTS request failed: ${res.status}`)
  }

  const audio = await res.blob()
  const engine = res.headers.get('X-TTS-Engine') || 'unknown'
  return { audio, engine }
}

export function playAudioBlob(blob: Blob): HTMLAudioElement {
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  audio.play()
  audio.onended = () => URL.revokeObjectURL(url)
  return audio
}

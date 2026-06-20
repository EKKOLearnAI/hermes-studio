import { request } from '../client'
import type { StoredSttProvider } from './stt-settings'

export interface TranscribeSpeechRequest {
  audio: Blob
  provider: StoredSttProvider
  language?: string
  prompt?: string
}

export interface TranscribeSpeechResponse {
  text: string
  provider: StoredSttProvider
  model: string
  language?: string
  durationMs: number
}

export async function transcribeSpeech(req: TranscribeSpeechRequest): Promise<TranscribeSpeechResponse> {
  if (!req.provider) {
    throw new Error('STT provider is required')
  }

  const formData = new FormData()
  formData.append('audio', req.audio, 'speech.webm')
  formData.append('provider', req.provider)

  if (typeof req.language === 'string' && req.language) {
    formData.append('language', req.language)
  }

  if (typeof req.prompt === 'string' && req.prompt) {
    formData.append('prompt', req.prompt)
  }

  return request<TranscribeSpeechResponse>('/api/hermes/stt/transcribe', {
    method: 'POST',
    body: formData,
  })
}

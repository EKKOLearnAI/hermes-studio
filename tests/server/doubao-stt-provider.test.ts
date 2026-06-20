import { beforeEach, describe, expect, it, vi } from 'vitest'

const audioConvertMock = vi.hoisted(() => ({
  transcodeToWav: vi.fn(async (audio: Buffer) => ({
    audio: Buffer.from(`wav:${audio.toString('utf-8')}`),
    mimeType: 'audio/wav',
    fileName: 'audio.wav',
  })),
}))

vi.mock('../../packages/server/src/services/hermes/stt-providers/audio-convert', () => audioConvertMock)

import { transcribeWithProvider } from '../../packages/server/src/services/hermes/stt-providers'
import { transcribeDoubaoFile } from '../../packages/server/src/services/hermes/stt-providers/doubao'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(body: unknown, init: { status?: number; statusText?: string; apiStatus?: string } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: new Headers(init.apiStatus ? { 'X-Api-Status-Code': init.apiStatus } : {}),
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}

function getHeader(headers: RequestInit['headers'] | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase())
    return match?.[1]
  }

  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return typeof match?.[1] === 'string' ? match[1] : undefined
}

function getCall(index: number): [string, RequestInit] {
  const [url, init] = mockFetch.mock.calls[index] as [string | URL, RequestInit]
  return [typeof url === 'string' ? url : url.toString(), init]
}

function bodyJson(init: RequestInit): any {
  expect(typeof init.body).toBe('string')
  return JSON.parse(init.body as string)
}

describe('transcribeDoubaoFile', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    audioConvertMock.transcodeToWav.mockReset()
    audioConvertMock.transcodeToWav.mockImplementation(async (audio: Buffer) => ({
      audio: Buffer.from(`wav:${audio.toString('utf-8')}`),
      mimeType: 'audio/wav',
      fileName: 'audio.wav',
    }))
  })

  it('submits base64 audio and polls the Doubao audio-file recognition result', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, { apiStatus: '20000000' }))
      .mockResolvedValueOnce(jsonResponse({
        result: {
          text: '打开西瓜白榜。',
          utterances: [],
        },
      }, { apiStatus: '20000000' }))

    const result = await transcribeDoubaoFile({
      provider: 'doubao',
      audio: Buffer.from('wav-audio'),
      fileName: 'speech.wav',
      mimeType: 'audio/wav',
      settings: {
        baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel',
        model: 'volc.seedasr.auc',
        language: 'zh',
        prompt: '西瓜白榜',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    expect(result).toMatchObject({
      text: '打开西瓜白榜。',
      provider: 'doubao',
      model: 'volc.seedasr.auc',
      language: 'zh',
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)

    const [submitUrl, submitInit] = getCall(0)
    expect(submitUrl).toBe('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit')
    expect(getHeader(submitInit.headers, 'X-Api-Key')).toBe('server-secret')
    expect(getHeader(submitInit.headers, 'X-Api-Resource-Id')).toBe('volc.seedasr.auc')
    expect(getHeader(submitInit.headers, 'X-Api-Sequence')).toBe('-1')
    const requestId = getHeader(submitInit.headers, 'X-Api-Request-Id')
    expect(requestId).toEqual(expect.any(String))

    const submitBody = bodyJson(submitInit)
    expect(submitBody.audio).toEqual({
      format: 'wav',
      data: Buffer.from('wav-audio').toString('base64'),
    })
    expect(submitBody.request).toMatchObject({
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      language: 'zh',
      corpus: { context: '西瓜白榜' },
    })

    const [queryUrl, queryInit] = getCall(1)
    expect(queryUrl).toBe('https://openspeech.bytedance.com/api/v3/auc/bigmodel/query')
    expect(getHeader(queryInit.headers, 'X-Api-Request-Id')).toBe(requestId)
    expect(bodyJson(queryInit)).toEqual({})
    expect(audioConvertMock.transcodeToWav).not.toHaveBeenCalled()
  })

  it('dispatches through the shared provider entrypoint', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, { apiStatus: '20000000' }))
      .mockResolvedValueOnce(jsonResponse({ result: { text: 'shared dispatch' } }, { apiStatus: '20000000' }))

    const result = await transcribeWithProvider({
      provider: 'doubao',
      audio: Buffer.from('audio'),
      fileName: 'speech.wav',
      mimeType: 'audio/wav',
      settings: {},
      secrets: {
        apiKey: 'server-secret',
      },
    })

    expect(result.text).toBe('shared dispatch')
    expect(result.model).toBe('volc.seedasr.auc')
  })

  it('transcodes browser webm audio to wav before upload when possible', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, { apiStatus: '20000000' }))
      .mockResolvedValueOnce(jsonResponse({ result: { text: 'converted' } }, { apiStatus: '20000000' }))

    await transcribeDoubaoFile({
      provider: 'doubao',
      audio: Buffer.from('webm-audio'),
      fileName: 'speech.webm',
      mimeType: 'audio/webm',
      settings: {},
      secrets: {
        apiKey: 'server-secret',
      },
    })

    expect(audioConvertMock.transcodeToWav).toHaveBeenCalledWith(Buffer.from('webm-audio'), 'audio/webm', {
      normalizeWav: false,
    })
    expect(bodyJson(getCall(0)[1]).audio).toEqual({
      format: 'wav',
      data: Buffer.from('wav:webm-audio').toString('base64'),
    })
  })

  it('normalizes wav audio when ffmpeg transcoding is requested', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, { apiStatus: '20000000' }))
      .mockResolvedValueOnce(jsonResponse({ result: { text: 'normalized' } }, { apiStatus: '20000000' }))

    await transcribeDoubaoFile({
      provider: 'doubao',
      audio: Buffer.from('mcu-wav'),
      fileName: 'mcu-voice.wav',
      mimeType: 'audio/wav',
      settings: {
        audioTranscode: 'ffmpeg',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    expect(audioConvertMock.transcodeToWav).toHaveBeenCalledWith(Buffer.from('mcu-wav'), 'audio/wav', {
      normalizeWav: true,
    })
    expect(bodyJson(getCall(0)[1]).audio).toEqual({
      format: 'wav',
      data: Buffer.from('wav:mcu-wav').toString('base64'),
    })
  })

  it('fails clearly when browser webm audio cannot be transcoded', async () => {
    audioConvertMock.transcodeToWav.mockResolvedValueOnce({
      audio: Buffer.from('webm-audio'),
      mimeType: 'audio/webm',
      fileName: '',
    })

    const error = await transcribeDoubaoFile({
      provider: 'doubao',
      audio: Buffer.from('webm-audio'),
      fileName: 'speech.webm',
      mimeType: 'audio/webm;codecs=opus',
      settings: {},
      secrets: {
        apiKey: 'server-secret',
      },
    }).catch(error => error)

    expect(String(error)).toContain('browser WebM/Opus recordings can be transcoded to WAV')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('redacts the API key in upstream errors', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('bad server-secret', { status: 403, statusText: 'Forbidden', apiStatus: '1001' }))

    const error = await transcribeDoubaoFile({
      provider: 'doubao',
      audio: Buffer.from('audio'),
      fileName: 'speech.wav',
      mimeType: 'audio/wav',
      settings: {},
      secrets: {
        apiKey: 'server-secret',
      },
    }).catch(error => error)

    expect(String(error)).toContain('Doubao STT submit failed')
    expect(String(error)).not.toContain('server-secret')
    expect(String(error)).toContain('[redacted]')
  })

  it('maps Doubao silent-audio status to a no-speech error', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, { apiStatus: '20000000' }))
      .mockResolvedValueOnce(jsonResponse({}, { apiStatus: '20000003' }))

    const error = await transcribeDoubaoFile({
      provider: 'doubao',
      audio: Buffer.from('quiet-wav'),
      fileName: 'speech.wav',
      mimeType: 'audio/wav',
      settings: {},
      secrets: {
        apiKey: 'server-secret',
      },
    }).catch(error => error)

    expect(error?.constructor?.name).toBe('SttNoSpeechDetectedError')
    expect(String(error)).toContain('No speech detected')
  })
})

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
import { transcribeOpenAiCompatible } from '../../packages/server/src/services/hermes/stt-providers/openai'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    async json() {
      return body
    },
    async text() {
      return JSON.stringify(body)
    },
  }
}

function textResponse(body: string, init: { status?: number; statusText?: string } = {}) {
  return {
    ok: (init.status ?? 500) >= 200 && (init.status ?? 500) < 300,
    status: init.status ?? 500,
    statusText: init.statusText ?? 'Error',
    async json() {
      return { error: body }
    },
    async text() {
      return body
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

  const entries = Object.entries(headers)
  const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase())
  return typeof match?.[1] === 'string' ? match[1] : undefined
}

function getRequestInit(): RequestInit {
  const [, init] = mockFetch.mock.calls[0] as [string | URL, RequestInit]
  return init
}

function getRequestUrl(): string {
  const [url] = mockFetch.mock.calls[0] as [string | URL, RequestInit]
  return typeof url === 'string' ? url : url.toString()
}

function getFormData(): FormData {
  const init = getRequestInit()
  expect(init.body).toBeInstanceOf(FormData)
  return init.body as FormData
}

describe('transcribeOpenAiCompatible', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    audioConvertMock.transcodeToWav.mockClear()
  })

  it('posts multipart audio using server-side API key', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'hello from voice' }))

    const result = await transcribeOpenAiCompatible({
      provider: 'openai',
      audio: Buffer.from('audio'),
      fileName: 'speech.webm',
      mimeType: 'audio/webm',
      settings: {
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    expect(result.text).toBe('hello from voice')
    expect(result.provider).toBe('openai')
    expect(result.model).toBe('gpt-4o-transcribe')
    expect(result.language).toBeUndefined()
    expect(result.durationMs).toEqual(expect.any(Number))
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(getRequestUrl()).toBe('https://api.openai.com/v1/audio/transcriptions')

    const init = getRequestInit()
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(getHeader(init.headers, 'Authorization')).toBe('Bearer server-secret')

    const form = getFormData()
    expect(form.get('model')).toBe('gpt-4o-transcribe')
    expect(form.get('language')).toBeNull()
    expect(form.get('prompt')).toBeNull()

    const file = form.get('file') as File
    expect(file).toBeTruthy()
    expect(file.name).toBe('speech.webm')
    expect(file.type).toBe('audio/webm')
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from('audio'))
    expect(audioConvertMock.transcodeToWav).not.toHaveBeenCalled()
  })

  it('transcodes audio to wav only when ffmpeg is selected', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'hello from wav' }))

    await transcribeOpenAiCompatible({
      provider: 'openai',
      audio: Buffer.from('audio'),
      fileName: 'speech.webm',
      mimeType: 'audio/webm',
      settings: {
        model: 'gpt-4o-transcribe',
        audioTranscode: 'ffmpeg',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    expect(audioConvertMock.transcodeToWav).toHaveBeenCalledWith(Buffer.from('audio'), 'audio/webm')
    const file = getFormData().get('file') as File
    expect(file.name).toBe('audio.wav')
    expect(file.type).toBe('audio/wav')
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from('wav:audio'))
  })

  it('rejects missing API key', async () => {
    await expect(
      transcribeOpenAiCompatible({
        provider: 'openai',
        audio: Buffer.from('audio'),
        fileName: 'speech.webm',
        mimeType: 'audio/webm',
        settings: {
          model: 'gpt-4o-transcribe',
        },
        secrets: {
          apiKey: '   ',
        },
      }),
    ).rejects.toThrow('OpenAI-compatible STT API key is required')

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects empty audio before fetch', async () => {
    await expect(
      transcribeOpenAiCompatible({
        provider: 'openai',
        audio: Buffer.alloc(0),
        fileName: 'speech.webm',
        mimeType: 'audio/webm',
        settings: {
          model: 'gpt-4o-transcribe',
        },
        secrets: {
          apiKey: 'server-secret',
        },
      }),
    ).rejects.toThrow('OpenAI-compatible STT audio is empty')

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws HTTP errors with status but does not leak the raw secret', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('upstream rejected bearer server-secret', { status: 401, statusText: 'Unauthorized' }))

    const error = await transcribeOpenAiCompatible({
      provider: 'openai',
      audio: Buffer.from('audio'),
      fileName: 'speech.webm',
      mimeType: 'audio/webm',
      settings: {
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    }).catch(error => error)

    expect(String(error)).toContain('401')
    expect(String(error)).not.toContain('server-secret')
  })

  it('rejects successful JSON responses that omit text', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: '   ' }))

    await expect(
      transcribeOpenAiCompatible({
        provider: 'openai',
        audio: Buffer.from('audio'),
        fileName: 'speech.webm',
        mimeType: 'audio/webm',
        settings: {
          model: 'gpt-4o-transcribe',
        },
        secrets: {
          apiKey: 'server-secret',
        },
      }),
    ).rejects.toThrow('OpenAI-compatible STT response text is empty')
  })

  it('custom provider derives the transcription endpoint from a base URL root', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'custom transcript' }))

    const result = await transcribeWithProvider({
      provider: 'custom',
      audio: Buffer.from('audio'),
      fileName: 'speech.webm',
      mimeType: 'audio/webm',
      settings: {
        baseUrl: 'https://custom.example.com/v1',
        model: 'whisper-1',
        language: 'fr',
        prompt: '  Summarize the French speech.  ',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    expect(result).toMatchObject({
      text: 'custom transcript',
      provider: 'custom',
      model: 'whisper-1',
      language: 'fr',
    })
    expect(getRequestUrl()).toBe('https://custom.example.com/v1/audio/transcriptions')
    expect(getHeader(getRequestInit().headers, 'Authorization')).toBe('Bearer server-secret')

    const form = getFormData()
    expect(form.get('language')).toBe('fr')
    expect(form.get('prompt')).toBe('Summarize the French speech.')
  })

  it('custom provider does not append a duplicate transcription path', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'custom transcript' }))

    await transcribeWithProvider({
      provider: 'custom',
      audio: Buffer.from('audio'),
      fileName: 'speech.webm',
      mimeType: 'audio/webm',
      settings: {
        baseUrl: 'https://custom.example.com/v1/audio/transcriptions',
        model: 'whisper-1',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    expect(getRequestUrl()).toBe('https://custom.example.com/v1/audio/transcriptions')
  })

  it.each([
    'http://10.0.0.1:8000/v1/audio/transcriptions',
    'http://172.16.0.1:8000/v1/audio/transcriptions',
    'http://192.168.1.1:8000/v1/audio/transcriptions',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:8000/v1/audio/transcriptions',
    'http://[fd00::1]:8000/v1/audio/transcriptions',
    'http://[fe90::1]:8000/v1/audio/transcriptions',
  ])('allows local or private custom baseUrl %s', async (baseUrl) => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'local transcript' }))

    const result = await transcribeWithProvider({
      provider: 'custom',
      audio: Buffer.from('audio'),
      fileName: 'speech.webm',
      mimeType: 'audio/webm',
      settings: {
        baseUrl,
        model: 'whisper-1',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    expect(result.text).toBe('local transcript')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('does not follow redirects to unsafe targets when fetch returns 302', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: 'Found',
      headers: {
        get(name: string) {
          return name.toLowerCase() === 'location' ? 'http://127.0.0.1:8000/internal' : null
        },
      },
      async json() {
        return {}
      },
      async text() {
        return ''
      },
    })

    const error = await transcribeOpenAiCompatible({
      provider: 'openai',
      audio: Buffer.from('audio'),
      fileName: 'speech.webm',
      mimeType: 'audio/webm',
      settings: {
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    }).catch(error => error)

    expect(String(error)).toContain('OpenAI-compatible STT returned HTTP 302')
    expect(String(error)).not.toContain('127.0.0.1')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(getRequestUrl()).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(getRequestInit().redirect).toBe('manual')
  })

  it('rejects unsupported providers', async () => {
    await expect(
      transcribeWithProvider({
        provider: 'openai-compatible' as any,
        audio: Buffer.from('audio'),
        fileName: 'speech.webm',
        mimeType: 'audio/webm',
        settings: {},
        secrets: {
          apiKey: 'server-secret',
        },
      }),
    ).rejects.toThrow('Unsupported STT provider: openai-compatible')
  })
})

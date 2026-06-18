import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mimoTtsProvider } from '../../packages/server/src/services/hermes/tts-providers/mimo'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  const text = JSON.stringify(body)
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    async json() {
      return body
    },
    async text() {
      return text
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

function getJsonBody() {
  const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
  expect(init?.body).toBeTypeOf('string')
  return JSON.parse(init.body as string)
}

describe('mimoTtsProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('bearer mode calls /chat/completions, sends Authorization bearer, and returns decoded audio buffer', async () => {
    const audioData = Buffer.from('mimo-audio').toString('base64')
    mockFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { audio: { data: audioData } } }],
    }))

    const signal = new AbortController().signal
    const result = await mimoTtsProvider.synthesize(
      { text: 'Hello <b>world</b>', signal },
      {
        baseUrl: 'https://mimo.example.com/',
        apiKey: 'secret',
        model: 'mimo-v2.5-tts',
        voice: 'alloy',
      },
    )

    expect(result).toEqual({
      audio: Buffer.from(audioData, 'base64'),
      contentType: 'audio/wav',
      engine: 'mimo',
      provider: 'mimo',
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://mimo.example.com/chat/completions')
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBe(signal)
    expect(getHeader(init?.headers, 'Authorization')).toBe('Bearer secret')
    expect(getHeader(init?.headers, 'api-key')).toBeUndefined()

    expect(getJsonBody()).toEqual({
      model: 'mimo-v2.5-tts',
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'Hello world' },
      ],
      audio: { format: 'wav', voice: 'alloy' },
    })
  })

  it('api-key mode sends api-key and no Authorization header', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { audio: { data: Buffer.from('ok').toString('base64') } } }],
    }))

    await mimoTtsProvider.synthesize(
      { text: 'Hello' },
      {
        baseUrl: 'https://mimo.example.com',
        apiKey: 'secret',
        authMode: 'api-key',
        model: 'mimo-v2.5-tts',
        voice: 'verse',
      },
    )

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(getHeader(init?.headers, 'api-key')).toBe('secret')
    expect(getHeader(init?.headers, 'Authorization')).toBeUndefined()
  })

  it('both mode sends both auth headers', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { audio: { data: Buffer.from('ok').toString('base64') } } }],
    }))

    await mimoTtsProvider.synthesize(
      { text: 'Hello' },
      {
        baseUrl: 'https://mimo.example.com',
        apiKey: 'secret',
        authMode: 'both',
        model: 'mimo-v2.5-tts',
        voice: 'verse',
      },
    )

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(getHeader(init?.headers, 'api-key')).toBe('secret')
    expect(getHeader(init?.headers, 'Authorization')).toBe('Bearer secret')
  })

  it('rejects invalid baseUrl values before fetch', async () => {
    for (const baseUrl of [
      'file:///tmp/tts',
      'https://user:pass@mimo.example.com/v1',
    ]) {
      await expect(
        mimoTtsProvider.synthesize(
          { text: 'Hello' },
          {
            baseUrl,
            apiKey: 'secret',
            model: 'mimo-v2.5-tts',
          },
        ),
      ).rejects.toThrow(/MiMo TTS baseUrl/)
    }

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('allows local or private baseUrl values', async () => {
    for (const baseUrl of [
      'http://localhost:8000/v1',
      'http://127.0.0.1:8000/v1',
      'http://[::1]:8000/v1',
      'http://169.254.169.254/latest',
    ]) {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { audio: { data: Buffer.from('audio').toString('base64') } } }],
      }))

      await mimoTtsProvider.synthesize(
        { text: 'Hello' },
        {
          baseUrl,
          apiKey: 'secret',
          model: 'mimo-v2.5-tts',
        },
      )
    }

    expect(mockFetch).toHaveBeenCalledTimes(4)
  })

  it('voiceDesign mode omits audio.voice and puts voiceDesignDesc/stylePrompt in user message', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { audio: { data: Buffer.from('ok').toString('base64') } } }],
    }))

    await mimoTtsProvider.synthesize(
      { text: 'Narrate this' },
      {
        baseUrl: 'https://mimo.example.com',
        apiKey: 'secret',
        model: 'mimo-v2.5-tts-voicedesign',
        voiceDesignDesc: 'Warm cinematic female voice',
        stylePrompt: 'Speak slowly with gravitas.',
      },
    )

    const body = getJsonBody()
    expect(body.audio).toEqual({ format: 'wav' })
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[0].content).toContain('Warm cinematic female voice')
    expect(body.messages[0].content).toContain('Speak slowly with gravitas.')
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'Narrate this' })
  })

  it('voiceClone model infers voiceClone mode and includes input_audio payload without audio.voice', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { audio: { data: Buffer.from('ok').toString('base64') } } }],
    }))

    await mimoTtsProvider.synthesize(
      { text: 'Hello <b>world</b>' },
      {
        baseUrl: 'https://mimo.example.com',
        apiKey: 'secret',
        model: 'mimo-v2.5-tts-voiceclone',
        voiceCloneDataUri: 'data:audio/wav;base64,ZmFrZQ==',
        voiceCloneFormat: 'mp3',
        stylePrompt: 'Match the cadence of the reference audio.',
      },
    )

    const body = getJsonBody()
    expect(body.audio).toEqual({ format: 'wav' })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Match the cadence of the reference audio.' },
          {
            type: 'input_audio',
            input_audio: {
              data: 'data:audio/wav;base64,ZmFrZQ==',
              format: 'mp3',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: 'Hello world',
      },
    ])
  })

  it('voiceClone mode rejects unsupported reference audio data URIs before fetch', async () => {
    await expect(
      mimoTtsProvider.synthesize(
        { text: 'Hello world' },
        {
          baseUrl: 'https://mimo.example.com',
          apiKey: 'secret',
          model: 'mimo-v2.5-tts-voiceclone',
          voiceCloneDataUri: 'data:audio/ogg;base64,ZmFrZQ==',
          voiceCloneFormat: 'wav',
        },
      ),
    ).rejects.toThrow('MiMo TTS voiceCloneDataUri must be an mp3 or wav data URI')

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('voiceClone mode rejects reference audio over 10 MiB before fetch', async () => {
    const tooLargeBase64 = `${'A'.repeat(Math.ceil(((10 * 1024 * 1024) + 1) / 3) * 4)}`

    await expect(
      mimoTtsProvider.synthesize(
        { text: 'Hello world' },
        {
          baseUrl: 'https://mimo.example.com',
          apiKey: 'secret',
          model: 'mimo-v2.5-tts-voiceclone',
          voiceCloneDataUri: `data:audio/wav;base64,${tooLargeBase64}`,
          voiceCloneFormat: 'wav',
        },
      ),
    ).rejects.toThrow('MiMo TTS voiceCloneDataUri must be 10 MiB or smaller')

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('voiceClone model rejects missing voiceCloneDataUri before fetch', async () => {
    await expect(
      mimoTtsProvider.synthesize(
        { text: 'Hello world' },
        {
          baseUrl: 'https://mimo.example.com',
          apiKey: 'secret',
          model: 'mimo-v2.5-tts-voiceclone',
        },
      ),
    ).rejects.toThrow('MiMo TTS voiceCloneDataUri is required for voiceClone mode')

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('voiceClone mode includes voiceCloneDataUri in payload and assistant message content is synthesis text', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { audio: { data: Buffer.from('ok').toString('base64') } } }],
    }))

    await mimoTtsProvider.synthesize(
      { text: 'Hello <b>world</b>' },
      {
        baseUrl: 'https://mimo.example.com',
        apiKey: 'secret',
        model: 'mimo-v2.5-tts',
        voiceMode: 'voiceClone',
        voiceCloneDataUri: 'data:audio/wav;base64,ZmFrZQ==',
        stylePrompt: 'Match the cadence of the reference audio.',
      },
    )

    const body = getJsonBody()
    expect(body.audio).toEqual({ format: 'wav' })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Match the cadence of the reference audio.' },
          {
            type: 'input_audio',
            input_audio: {
              data: 'data:audio/wav;base64,ZmFrZQ==',
              format: 'wav',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: 'Hello world',
      },
    ])
  })

  it('non-ok response throws error containing status and body', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('bad request body', { status: 401, statusText: 'Unauthorized' }))

    await expect(
      mimoTtsProvider.synthesize(
        { text: 'Hello' },
        {
          baseUrl: 'https://mimo.example.com',
          apiKey: 'secret',
          model: 'mimo-v2.5-tts',
        },
      ),
    ).rejects.toThrow('MiMo TTS returned 401: bad request body')
  })
})

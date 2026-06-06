import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clampTtsText, cleanTtsText } from '../../packages/server/src/services/hermes/tts-providers/text'
import { customTtsProvider, openaiTtsProvider } from '../../packages/server/src/services/hermes/tts-providers/openai'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function audioResponse(
  bytes: Buffer | Uint8Array,
  init: { status?: number; statusText?: string; contentType?: string } = {},
) {
  const buffer = Buffer.from(bytes)
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'content-type') {
          return init.contentType ?? null
        }
        return null
      },
    },
    async arrayBuffer() {
      return buffer
    },
    async text() {
      return buffer.toString('utf8')
    },
  }
}

function textResponse(body: string, init: { status?: number; statusText?: string } = {}) {
  return {
    ok: (init.status ?? 500) >= 200 && (init.status ?? 500) < 300,
    status: init.status ?? 500,
    statusText: init.statusText ?? 'Error',
    headers: {
      get() {
        return null
      },
    },
    async arrayBuffer() {
      return Buffer.from(body)
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

describe('openaiTtsProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('normalizes baseUrl, posts to /audio/speech, sends bearer auth, and defaults model/voice with cleaned text', async () => {
    const audio = Buffer.from('openai-audio')
    mockFetch.mockResolvedValueOnce(audioResponse(audio, { contentType: 'audio/ogg' }))
    const signal = new AbortController().signal
    const text = 'Hello <b>world</b> ```ts\nsecret()\n``` '.repeat(120)

    const result = await openaiTtsProvider.synthesize(
      { text, signal },
      {
        baseUrl: 'https://api.example.com///',
        apiKey: 'secret',
      },
    )

    expect(result).toEqual({
      audio,
      contentType: 'audio/ogg',
      engine: 'openai',
      provider: 'openai',
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/audio/speech')
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBe(signal)
    expect(getHeader(init?.headers, 'Content-Type')).toBe('application/json')
    expect(getHeader(init?.headers, 'Authorization')).toBe('Bearer secret')

    expect(getJsonBody()).toEqual({
      model: 'tts-1',
      voice: 'alloy',
      input: clampTtsText(cleanTtsText(text)),
    })
  })

  it('includes rate and pitch only when provided', async () => {
    mockFetch.mockResolvedValueOnce(audioResponse(Buffer.from('ok')))

    await openaiTtsProvider.synthesize(
      { text: 'Hello' },
      {
        baseUrl: 'https://api.example.com',
        voice: 'nova',
        model: 'tts-1-hd',
        rate: '+20%',
        pitch: '-8Hz',
      },
    )

    expect(getJsonBody()).toEqual({
      model: 'tts-1-hd',
      voice: 'nova',
      input: 'Hello',
      rate: '+20%',
      pitch: '-8Hz',
    })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(getHeader(init?.headers, 'Authorization')).toBeUndefined()
  })

  it('appends /audio/speech to versioned base urls without duplicating slashes', async () => {
    mockFetch.mockResolvedValueOnce(audioResponse(Buffer.from('ok')))

    await openaiTtsProvider.synthesize(
      { text: 'Hello' },
      {
        baseUrl: 'https://api.example.com/v1/',
      },
    )

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/audio/speech')
  })

  it('does not double-append /audio/speech when baseUrl already targets the speech endpoint', async () => {
    mockFetch.mockResolvedValueOnce(audioResponse(Buffer.from('ok')))

    await openaiTtsProvider.synthesize(
      { text: 'Hello' },
      {
        baseUrl: 'https://api.example.com/v1/audio/speech',
      },
    )

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/audio/speech')
  })

  it('preserves query strings and drops hashes when appending /audio/speech', async () => {
    mockFetch.mockResolvedValueOnce(audioResponse(Buffer.from('ok')))

    await openaiTtsProvider.synthesize(
      { text: 'Hello' },
      {
        baseUrl: 'https://api.example.com/v1?api-version=2024-01-01#frag',
      },
    )

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/audio/speech?api-version=2024-01-01')
  })

  it('preserves query strings and drops hashes when baseUrl already targets the speech endpoint', async () => {
    mockFetch.mockResolvedValueOnce(audioResponse(Buffer.from('ok')))

    await openaiTtsProvider.synthesize(
      { text: 'Hello' },
      {
        baseUrl: 'https://api.example.com/v1/audio/speech?api-version=2024-01-01#frag',
      },
    )

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/audio/speech?api-version=2024-01-01')
  })

  it('rejects unsafe baseUrl values before fetch', async () => {
    for (const baseUrl of [
      'file:///tmp/tts',
      'http://localhost:8000/v1',
      'http://127.0.0.1:8000/v1',
      'http://[::1]:8000/v1',
      'http://169.254.169.254/latest',
      'https://user:pass@api.example.com/v1',
    ]) {
      await expect(
        openaiTtsProvider.synthesize(
          { text: 'Hello' },
          { baseUrl },
        ),
      ).rejects.toThrow(/OpenAI TTS baseUrl/)
    }

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('throws non-ok responses with status and body text', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('bad request body', { status: 401, statusText: 'Unauthorized' }))

    await expect(
      openaiTtsProvider.synthesize(
        { text: 'Hello' },
        {
          baseUrl: 'https://api.example.com',
        },
      ),
    ).rejects.toThrow('OpenAI TTS returned 401: bad request body')
  })

  it('throws before fetch when cleaned text is empty', async () => {
    await expect(
      openaiTtsProvider.synthesize(
        { text: '<think>secret</think>   <b></b>' },
        {
          baseUrl: 'https://api.example.com',
        },
      ),
    ).rejects.toThrow('OpenAI TTS text is empty after cleaning')

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('custom provider reuses OpenAI-compatible speech requests but reports provider=custom', async () => {
    const audio = Buffer.from('custom-audio')
    mockFetch.mockResolvedValueOnce(audioResponse(audio, { contentType: 'audio/mpeg' }))

    const result = await customTtsProvider.synthesize(
      { text: 'Hello custom' },
      {
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'custom-secret',
      },
    )

    expect(result).toEqual({
      audio,
      contentType: 'audio/mpeg',
      engine: 'custom',
      provider: 'custom',
    })

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://custom.example.com/v1/audio/speech')
    expect(getHeader(init?.headers, 'Authorization')).toBe('Bearer custom-secret')
  })

  it('falls back to audio/mpeg when content-type header is missing', async () => {
    const audio = Buffer.from('fallback-audio')
    mockFetch.mockResolvedValueOnce(audioResponse(audio))

    const result = await openaiTtsProvider.synthesize(
      { text: 'Hello' },
      {
        baseUrl: 'https://api.example.com',
      },
    )

    expect(result).toEqual({
      audio,
      contentType: 'audio/mpeg',
      engine: 'openai',
      provider: 'openai',
    })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { doubaoTtsProvider } from '../../packages/server/src/services/hermes/tts-providers/doubao'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function textResponse(body: string, init: { status?: number; contentType?: string } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: 'OK',
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'content-type') return init.contentType || 'application/json'
        return null
      },
    },
    async text() {
      return body
    },
    async arrayBuffer() {
      return Buffer.from(body)
    },
  }
}

function getJsonBody() {
  const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
  expect(init?.body).toBeTypeOf('string')
  return JSON.parse(init.body as string)
}

describe('doubaoTtsProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('defaults to mp3 at 24kHz for browser playback compatibility', async () => {
    const audio = Buffer.from('mp3-audio')
    mockFetch.mockResolvedValueOnce(textResponse(JSON.stringify({
      data: audio.toString('base64'),
    })))

    const result = await doubaoTtsProvider.synthesize(
      { text: '你好' },
      {
        apiKey: 'secret',
      },
    )

    expect(result).toEqual({
      audio,
      contentType: 'audio/mpeg',
      engine: 'doubao',
      provider: 'doubao',
    })
    expect(getJsonBody().req_params.audio_params).toEqual({
      format: 'mp3',
      sample_rate: 24000,
    })
  })

  it('overrides audio format and sample rate when requested for MCU playback', async () => {
    const pcm = Buffer.from('pcm-audio')
    mockFetch.mockResolvedValueOnce(textResponse(JSON.stringify({
      data: pcm.toString('base64'),
    })))

    const result = await doubaoTtsProvider.synthesize(
      { text: '已经找到设备。' },
      {
        apiKey: 'secret',
        format: 'pcm',
        sampleRate: 16000,
      },
    )

    expect(result).toEqual({
      audio: pcm,
      contentType: 'audio/x-pcm',
      engine: 'doubao',
      provider: 'doubao',
    })
    expect(getJsonBody().req_params.audio_params).toEqual({
      format: 'pcm',
      sample_rate: 16000,
    })
  })

  it('rejects unsupported formats before calling Doubao', async () => {
    await expect(doubaoTtsProvider.synthesize(
      { text: 'hello' },
      {
        apiKey: 'secret',
        format: 'flac',
      },
    )).rejects.toThrow('Doubao TTS format must be one of')

    expect(mockFetch).not.toHaveBeenCalled()
  })
})

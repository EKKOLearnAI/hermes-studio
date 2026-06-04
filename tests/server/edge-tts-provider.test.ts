import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clampTtsText, cleanTtsText } from '../../packages/server/src/services/hermes/tts-providers/text'

const { textToSpeech } = vi.hoisted(() => ({
  textToSpeech: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/tts', () => ({
  textToSpeech,
}))

import { edgeTtsProvider } from '../../packages/server/src/services/hermes/tts-providers/edge'

describe('edgeTtsProvider', () => {
  beforeEach(() => {
    textToSpeech.mockReset()
  })

  it('wraps legacy textToSpeech and maps cleaned text with voice, rate, and pitch', async () => {
    const audio = Buffer.from('edge-audio')
    textToSpeech.mockResolvedValueOnce({ audio, engine: 'legacy-edge' })
    const text = 'Hello <b>world</b> ```ts\nsecret()\n``` '.repeat(120)

    const result = await edgeTtsProvider.synthesize(
      { text },
      {
        baseUrl: 'https://unused.example.com',
        voice: 'en-US-JennyNeural',
        rate: '+20%',
        pitch: '-8Hz',
      },
    )

    expect(textToSpeech).toHaveBeenCalledTimes(1)
    expect(textToSpeech).toHaveBeenCalledWith({
      text: clampTtsText(cleanTtsText(text)),
      voice: 'en-US-JennyNeural',
      rate: '+20%',
      pitch: '-8Hz',
    })
    expect(result).toEqual({
      audio,
      contentType: 'audio/mpeg',
      engine: 'legacy-edge',
      provider: 'edge',
    })
  })

  it('throws before calling legacy textToSpeech when cleaned text is empty', async () => {
    await expect(
      edgeTtsProvider.synthesize(
        { text: '<thinking>secret</thinking> <br/>' },
        {
          baseUrl: 'https://unused.example.com',
        },
      ),
    ).rejects.toThrow('Edge TTS text is empty after cleaning')

    expect(textToSpeech).not.toHaveBeenCalled()
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      edgeTtsProvider.synthesize(
        { text: 'Hello world', signal: controller.signal },
        {
          baseUrl: 'https://unused.example.com',
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(textToSpeech).not.toHaveBeenCalled()
  })

  it('rejects in-flight when the signal aborts before legacy textToSpeech resolves', async () => {
    let resolveTextToSpeech: ((value: { audio: Buffer; engine: string }) => void) | undefined
    textToSpeech.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTextToSpeech = resolve
    }))

    const controller = new AbortController()
    const pending = edgeTtsProvider.synthesize(
      { text: 'Hello world', signal: controller.signal },
      {
        baseUrl: 'https://unused.example.com',
      },
    )

    expect(textToSpeech).toHaveBeenCalledTimes(1)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    resolveTextToSpeech?.({ audio: Buffer.from('late-audio'), engine: 'legacy-edge' })
  })
})

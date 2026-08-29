import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  elevenLabsTtsProvider,
  geminiTtsProvider,
  minimaxTtsProvider,
  mistralTtsProvider,
  xaiTtsProvider,
} from '../../packages/server/src/modules/studio/services/voice/tts/providers/hermes-cloud'
import { deepinfraTtsProvider } from '../../packages/server/src/modules/studio/services/voice/tts/providers/openai'
import { transcribeWithProvider } from '../../packages/server/src/modules/studio/services/voice/stt'

afterEach(() => {
  vi.unstubAllGlobals()
})

function fetchCall(mock: ReturnType<typeof vi.fn>) {
  const [url, init] = mock.mock.calls[0] as [URL | string, RequestInit]
  return { url: String(url), init }
}

describe('Hermes-compatible cloud TTS providers', () => {
  it('uses the ElevenLabs REST shape from Hermes Agent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from('mp3'), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const output = await elevenLabsTtsProvider.synthesize({ text: 'hello' }, { apiKey: 'el-key' })
    const { url, init } = fetchCall(fetchMock)

    expect(url).toContain('/v1/text-to-speech/pNInz6obpgDQGcFmaJgB')
    expect(url).toContain('output_format=mp3_44100_128')
    expect(init.headers).toMatchObject({ 'xi-api-key': 'el-key' })
    expect(JSON.parse(String(init.body))).toMatchObject({
      text: 'hello',
      model_id: 'eleven_multilingual_v2',
    })
    expect(output.audio.toString()).toBe('mp3')
  })

  it('uses the xAI dedicated TTS endpoint and payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from('xai-audio'), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await xaiTtsProvider.synthesize({ text: 'hello' }, {
      apiKey: 'xai-key',
      voice: 'eve',
      language: 'en',
      sampleRate: '24000',
      bitRate: '128000',
    })
    const { url, init } = fetchCall(fetchMock)
    const body = JSON.parse(String(init.body))

    expect(url).toBe('https://api.x.ai/v1/tts')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer xai-key' })
    expect(body).toMatchObject({
      text: 'hello',
      voice_id: 'eve',
      language: 'en',
      output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 },
    })
  })

  it('decodes Mistral base64 audio_data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      audio_data: Buffer.from('mistral-audio').toString('base64'),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const output = await mistralTtsProvider.synthesize({ text: 'hello' }, { apiKey: 'mistral-key' })
    const { url, init } = fetchCall(fetchMock)

    expect(url).toBe('https://api.mistral.ai/v1/audio/speech')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'voxtral-mini-tts-2603',
      voice_id: 'c69964a6-ab8b-4f8a-9465-ec0925096ec8',
      response_format: 'mp3',
    })
    expect(output.audio.toString()).toBe('mistral-audio')
  })

  it('wraps Gemini 24 kHz PCM as WAV', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            inlineData: { data: Buffer.from([1, 2, 3, 4]).toString('base64') },
          }],
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const output = await geminiTtsProvider.synthesize({ text: 'hello' }, { apiKey: 'gemini-key' })
    const { url, init } = fetchCall(fetchMock)

    expect(url).toContain('/v1beta/models/gemini-2.5-flash-preview-tts:generateContent')
    expect(url).toContain('key=gemini-key')
    expect(JSON.parse(String(init.body))).toMatchObject({
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
      },
    })
    expect(output.contentType).toBe('audio/wav')
    expect(output.audio.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(output.audio.subarray(8, 12).toString('ascii')).toBe('WAVE')
  })

  it('decodes MiniMax t2a_v2 hex audio', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { audio: Buffer.from('minimax-audio').toString('hex') },
      base_resp: { status_code: 0 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const output = await minimaxTtsProvider.synthesize({ text: 'hello' }, {
      apiKey: 'minimax-key',
      groupId: 'group-1',
    })
    const { url, init } = fetchCall(fetchMock)

    expect(url).toContain('/v1/t2a_v2?GroupId=group-1')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'speech-02-hd',
      text: 'hello',
      voice_setting: {
        voice_id: 'English_expressive_narrator',
        speed: 1,
        vol: 1,
        pitch: 0,
        emotion: 'neutral',
      },
    })
    expect(output.audio.toString()).toBe('minimax-audio')
  })

  it('uses DeepInfra through its OpenAI-compatible audio endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(Buffer.from('deepinfra-audio'), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await deepinfraTtsProvider.synthesize({ text: 'hello' }, {
      apiKey: 'deepinfra-key',
      model: 'deepinfra/tts-model',
    })
    const { url, init } = fetchCall(fetchMock)

    expect(url).toBe('https://api.deepinfra.com/v1/openai/audio/speech')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer deepinfra-key' })
  })
})

describe('Hermes-compatible cloud STT providers', () => {
  const audio = Buffer.from('fake-audio')

  it('uses xAI /v1/stt with Hermes fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: 'xai transcript',
      language: 'en',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const output = await transcribeWithProvider({
      provider: 'xai',
      audio,
      fileName: 'audio.wav',
      mimeType: 'audio/wav',
      settings: { language: 'en', format: 'true', diarize: 'true' },
      secrets: { apiKey: 'xai-key' },
    })
    const { url, init } = fetchCall(fetchMock)
    const form = init.body as FormData

    expect(url).toBe('https://api.x.ai/v1/stt')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer xai-key' })
    expect(form.get('language')).toBe('en')
    expect(form.get('format')).toBe('true')
    expect(form.get('diarize')).toBe('true')
    expect(output.text).toBe('xai transcript')
  })

  it('uses ElevenLabs Scribe fields and xi-api-key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: 'scribe transcript',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const output = await transcribeWithProvider({
      provider: 'elevenlabs',
      audio,
      fileName: 'audio.wav',
      mimeType: 'audio/wav',
      settings: {
        model: 'scribe_v2',
        language: 'zh',
        tagAudioEvents: 'false',
        diarize: 'false',
      },
      secrets: { apiKey: 'el-key' },
    })
    const { url, init } = fetchCall(fetchMock)
    const form = init.body as FormData

    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect(init.headers).toMatchObject({ 'xi-api-key': 'el-key' })
    expect(form.get('model_id')).toBe('scribe_v2')
    expect(form.get('language_code')).toBe('zh')
    expect(form.get('tag_audio_events')).toBe('false')
    expect(form.get('diarize')).toBe('false')
    expect(output.text).toBe('scribe transcript')
  })

  it.each([
    ['groq', 'https://api.groq.com/openai/v1/audio/transcriptions', 'whisper-large-v3-turbo'],
    ['mistral', 'https://api.mistral.ai/v1/audio/transcriptions', 'voxtral-mini-latest'],
    ['deepinfra', 'https://api.deepinfra.com/v1/openai/audio/transcriptions', 'openai/whisper-large-v3'],
  ] as const)('uses the verified OpenAI-compatible contract for %s', async (provider, expectedUrl, expectedModel) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: `${provider} transcript`,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const output = await transcribeWithProvider({
      provider,
      audio,
      fileName: 'audio.wav',
      mimeType: 'audio/wav',
      settings: {},
      secrets: { apiKey: `${provider}-key` },
    })
    const { url, init } = fetchCall(fetchMock)
    const form = init.body as FormData

    expect(url).toBe(expectedUrl)
    expect(form.get('model')).toBe(expectedModel)
    expect(output.provider).toBe(provider)
  })
})

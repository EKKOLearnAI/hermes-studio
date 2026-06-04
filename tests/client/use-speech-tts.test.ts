// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const createObjectURL = vi.fn()
const revokeObjectURL = vi.fn()
vi.stubGlobal('URL', {
  createObjectURL,
  revokeObjectURL,
})

const audioInstances: MockAudio[] = []
let objectUrlCounter = 0

class MockAudio {
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn().mockResolvedValue(undefined)
  pause = vi.fn()

  constructor(src = '') {
    this.src = src
    audioInstances.push(this)
  }
}

vi.stubGlobal('Audio', MockAudio)

function installSpeechSynthesisMock() {
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speaking: false,
      pending: false,
      paused: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getVoices: vi.fn(() => []),
      speak: vi.fn(),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    },
  })
}

describe('client TTS unified synthesize flow', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('hermes_server_url', 'https://hermes.example')
    localStorage.setItem('hermes_api_key', 'secret-key')
    objectUrlCounter = 0
    createObjectURL.mockImplementation(() => `blob:mock-${++objectUrlCounter}`)
    audioInstances.length = 0
    installSpeechSynthesisMock()
  })

  it('synthesizeSpeech posts to the unified endpoint with auth, body, and signal', async () => {
    mockFetch.mockResolvedValue(new Response('audio-bytes', {
      status: 200,
      headers: {
        'X-TTS-Engine': 'openai-engine',
        'X-TTS-Provider': 'openai',
        'Content-Type': 'audio/mpeg',
      },
    }))

    const { synthesizeSpeech } = await import('../../packages/client/src/api/hermes/tts')
    const controller = new AbortController()

    const result = await synthesizeSpeech({
      provider: 'openai',
      text: 'Hello world',
      options: { voice: 'alloy', model: 'tts-1' },
      signal: controller.signal,
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hermes.example/api/hermes/tts/synthesize',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-key',
        },
        body: JSON.stringify({
          provider: 'openai',
          text: 'Hello world',
          options: { voice: 'alloy', model: 'tts-1' },
        }),
        signal: controller.signal,
      },
    )
    expect(result.audio).toBeInstanceOf(Blob)
    expect(result.audio.size).toBeGreaterThan(0)
    expect(result.engine).toBe('openai-engine')
    expect(result.provider).toBe('openai')
  })

  it('openaiPlay routes through the unified synthesize endpoint with provider=openai', async () => {
    mockFetch.mockResolvedValue(new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
      status: 200,
      headers: {
        'X-TTS-Engine': 'openai',
        'X-TTS-Provider': 'openai',
      },
    }))

    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    await speech.openaiPlay('msg-openai', 'Hello from OpenAI', {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'provider-key',
      model: 'tts-1',
      voice: 'alloy',
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://hermes.example/api/hermes/tts/synthesize')
    expect(url).not.toContain('/audio/speech')
    expect(JSON.parse(options.body)).toEqual({
      provider: 'openai',
      text: 'Hello from OpenAI',
      options: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'provider-key',
        model: 'tts-1',
        voice: 'alloy',
      },
    })
  })

  it('mimoPlay routes through the unified synthesize endpoint with provider=mimo', async () => {
    mockFetch.mockResolvedValue(new Response(new Blob(['mimo-audio'], { type: 'audio/wav' }), {
      status: 200,
      headers: {
        'X-TTS-Engine': 'mimo',
        'X-TTS-Provider': 'mimo',
      },
    }))

    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    await speech.mimoPlay('msg-mimo', 'Hello from MiMo', {
      baseUrl: 'https://mimo.example/v1',
      apiKey: 'mimo-key',
      model: 'mimo-v2.5-tts',
      voice: 'verse',
      stylePrompt: 'warm and calm',
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://hermes.example/api/hermes/tts/synthesize')
    expect(url).not.toContain('/chat/completions')
    expect(JSON.parse(options.body)).toEqual({
      provider: 'mimo',
      text: 'Hello from MiMo',
      options: {
        baseUrl: 'https://mimo.example/v1',
        apiKey: 'mimo-key',
        model: 'mimo-v2.5-tts',
        voice: 'verse',
        stylePrompt: 'warm and calm',
      },
    })
  })

  it('stop aborts a pending unified custom TTS request and clears custom state', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    let capturedSignal: AbortSignal | undefined

    mockFetch.mockImplementation((_url, options: RequestInit) => {
      capturedSignal = options.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => reject(abortError), { once: true })
      })
    })

    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    const pending = speech.openaiPlay('msg-stop', 'Stop me', {
      baseUrl: 'https://custom.example/v1',
    })

    expect(speech.isCustomPlaying.value).toBe(true)
    expect(speech.isCustomPaused.value).toBe(false)
    expect(speech.currentCustomMessageId.value).toBe('msg-stop')

    speech.stop()

    expect(capturedSignal?.aborted).toBe(true)
    expect(speech.isCustomPlaying.value).toBe(false)
    expect(speech.isCustomPaused.value).toBe(false)
    expect(speech.currentCustomMessageId.value).toBe(null)

    await pending.catch(() => undefined)
  })

  it('handles AbortError silently without console.error and clears custom state', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockFetch.mockRejectedValue(abortError)

    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    await expect(speech.openaiPlay('msg-abort', 'Abort me', {
      baseUrl: 'https://custom.example/v1',
    })).resolves.toBeUndefined()

    expect(consoleError).not.toHaveBeenCalled()
    expect(speech.isCustomPlaying.value).toBe(false)
    expect(speech.isCustomPaused.value).toBe(false)
    expect(speech.currentCustomMessageId.value).toBe(null)
  })

  it('revokes custom audio object URLs when stop() stops custom playback', async () => {
    mockFetch.mockResolvedValue(new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
      status: 200,
      headers: {
        'X-TTS-Engine': 'openai',
        'X-TTS-Provider': 'custom',
      },
    }))

    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    await speech.openaiPlay('msg-audio', 'Audio to stop', {
      baseUrl: 'https://custom.example/v1',
    })

    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(audioInstances).toHaveLength(1)
    const [audio] = audioInstances

    const createdUrl = createObjectURL.mock.results[0]?.value

    speech.stop()

    expect(audio.pause).toHaveBeenCalledOnce()
    expect(audio.src).toBe('')
    expect(revokeObjectURL).toHaveBeenCalledWith(createdUrl)
    expect(speech.isCustomPlaying.value).toBe(false)
    expect(speech.currentCustomMessageId.value).toBe(null)
  })
})

// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
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

function flushPromises() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

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
      authMode: 'api-key',
      model: 'mimo-v2.5-tts',
      voiceMode: 'voiceClone',
      voice: 'verse',
      voiceCloneDataUri: 'data:audio/wav;base64,ZmFrZQ==',
      voiceCloneFormat: 'wav',
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
        authMode: 'api-key',
        model: 'mimo-v2.5-tts',
        voiceMode: 'voiceClone',
        voice: 'verse',
        voiceCloneDataUri: 'data:audio/wav;base64,ZmFrZQ==',
        voiceCloneFormat: 'wav',
        stylePrompt: 'warm and calm',
      },
    })
  })

  it('openaiPlay respects an explicit edge provider even when other fields look OpenAI-compatible', async () => {
    mockFetch.mockResolvedValue(new Response(new Blob(['edge-audio'], { type: 'audio/mpeg' }), {
      status: 200,
      headers: { 'X-TTS-Provider': 'edge' },
    }))
    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    await speech.openaiPlay('msg-edge-explicit', 'Edge explicit', {
      provider: 'edge',
      baseUrl: 'https://api.openai.com/v1',
      model: 'tts-1',
      voice: 'zh-CN-XiaoxiaoNeural',
    })

    const [, options] = mockFetch.mock.calls[0]
    expect(JSON.parse(options.body).provider).toBe('edge')
  })

  it('openaiPlay falls back to edge for the legacy /api/tts/proxy baseUrl', async () => {
    mockFetch.mockResolvedValue(new Response(new Blob(['edge-audio'], { type: 'audio/mpeg' }), {
      status: 200,
      headers: { 'X-TTS-Provider': 'edge' },
    }))
    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    await speech.openaiPlay('msg-edge-fallback', 'Edge fallback', {
      baseUrl: '/api/tts/proxy',
      voice: 'zh-CN-XiaoxiaoNeural',
    })

    const [, options] = mockFetch.mock.calls[0]
    expect(JSON.parse(options.body).provider).toBe('edge')
  })

  it('openaiPlay falls back to custom for non-proxy endpoints without a model', async () => {
    mockFetch.mockResolvedValue(new Response(new Blob(['custom-audio'], { type: 'audio/mpeg' }), {
      status: 200,
      headers: { 'X-TTS-Provider': 'custom' },
    }))
    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    await speech.openaiPlay('msg-custom-fallback', 'Custom fallback', {
      baseUrl: 'https://custom.example/v1',
      apiKey: 'custom-key',
    })

    const [, options] = mockFetch.mock.calls[0]
    expect(JSON.parse(options.body).provider).toBe('custom')
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

  it('openaiToggle handles request failures without an unhandled rejection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockFetch.mockRejectedValue(new Error('upstream failed'))

    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    speech.openaiToggle('msg-toggle-fail', 'Fail through toggle', {
      provider: 'custom',
      baseUrl: 'https://custom.example/v1',
    })
    await flushPromises()

    expect(consoleError).toHaveBeenCalledWith('[useSpeech] OpenAI TTS 请求失败:', expect.any(Error))
    expect(speech.isCustomPlaying.value).toBe(false)
    expect(speech.isCustomPaused.value).toBe(false)
    expect(speech.currentCustomMessageId.value).toBe(null)
  })

  it('handles custom audio resume play() rejection', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch.mockResolvedValue(new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
      status: 200,
      headers: { 'X-TTS-Provider': 'custom' },
    }))

    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    await speech.openaiPlay('msg-resume', 'Audio to resume', {
      provider: 'custom',
      baseUrl: 'https://custom.example/v1',
    })
    const [audio] = audioInstances

    speech.openaiToggle('msg-resume', 'Audio to resume', {
      provider: 'custom',
      baseUrl: 'https://custom.example/v1',
    })
    audio.play.mockRejectedValueOnce(new Error('play blocked'))
    speech.openaiToggle('msg-resume', 'Audio to resume', {
      provider: 'custom',
      baseUrl: 'https://custom.example/v1',
    })
    await flushPromises()

    expect(consoleWarn).toHaveBeenCalledWith('[useSpeech] Custom TTS audio resume failed:', expect.any(Error))
    expect(speech.isCustomPaused.value).toBe(true)
  })

  it('pause() pauses active custom audio and preserves the current custom message', async () => {
    mockFetch.mockResolvedValue(new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
      status: 200,
      headers: { 'X-TTS-Provider': 'custom' },
    }))

    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    await speech.openaiPlay('msg-custom-pause', 'Audio to pause', {
      provider: 'custom',
      baseUrl: 'https://custom.example/v1',
    })
    const [audio] = audioInstances

    speech.pause()

    expect(audio.pause).toHaveBeenCalledOnce()
    expect(speech.isCustomPlaying.value).toBe(true)
    expect(speech.isCustomPaused.value).toBe(true)
    expect(speech.currentCustomMessageId.value).toBe('msg-custom-pause')
  })

  it('resume() resumes paused custom audio and clears the custom paused flag', async () => {
    mockFetch.mockResolvedValue(new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
      status: 200,
      headers: { 'X-TTS-Provider': 'custom' },
    }))

    const { useSpeech } = await import('../../packages/client/src/composables/useSpeech')
    const speech = useSpeech()

    await speech.openaiPlay('msg-custom-resume', 'Audio to resume globally', {
      provider: 'custom',
      baseUrl: 'https://custom.example/v1',
    })
    const [audio] = audioInstances
    speech.pause()
    audio.play.mockClear()

    speech.resume()
    await flushPromises()

    expect(audio.play).toHaveBeenCalledOnce()
    expect(speech.isCustomPlaying.value).toBe(true)
    expect(speech.isCustomPaused.value).toBe(false)
    expect(speech.currentCustomMessageId.value).toBe('msg-custom-resume')
  })

  it('same-message toggle during pending custom synthesis aborts before audio playback starts', async () => {
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

    speech.openaiToggle('msg-pending-toggle', 'Audio still synthesizing', {
      provider: 'custom',
      baseUrl: 'https://custom.example/v1',
    })
    expect(speech.isCustomPlaying.value).toBe(true)

    speech.openaiToggle('msg-pending-toggle', 'Audio still synthesizing', {
      provider: 'custom',
      baseUrl: 'https://custom.example/v1',
    })
    await flushPromises()

    expect(capturedSignal?.aborted).toBe(true)
    expect(audioInstances).toHaveLength(0)
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

describe('client TTS autoplay call sites', () => {
  it('catches fire-and-forget custom TTS autoplay promises', () => {
    const messageItem = readFileSync('packages/client/src/components/hermes/chat/MessageItem.vue', 'utf8')
    const groupMessageItem = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageItem.vue', 'utf8')

    expect(messageItem).toContain('function handleAutoplayTtsError')
    expect(messageItem).toContain('void speech.openaiPlay')
    expect(messageItem).toContain('void speech.mimoPlay')
    expect(messageItem).toContain('.catch(handleAutoplayTtsError)')

    expect(groupMessageItem).toContain('function handleAutoplayTtsError')
    expect(groupMessageItem).toContain('void speech.openaiPlay')
    expect(groupMessageItem).toContain('void speech.mimoPlay')
    expect(groupMessageItem).toContain('.catch(handleAutoplayTtsError)')
  })
})

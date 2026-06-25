// @vitest-environment jsdom
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'hermes.chat' } },
    replace: vi.fn(),
  },
}))

import router from '@/router'
import { hasApiKey } from '../../packages/client/src/api/client'
import { clearSttSecret, deleteSttBaseUrlPreset, deleteSttProvider, fetchSttSettings, saveActiveSttProvider, saveSttSettings } from '../../packages/client/src/api/hermes/stt-settings'
import { transcribeSpeech } from '../../packages/client/src/api/hermes/stt'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

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

describe('stt api wrappers', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('hermes_server_url', 'https://hermes.example')
    localStorage.setItem('hermes_api_key', 'jwt-token')
  })

  it('fetches provider settings through the shared client request flow and normalizes settings arrays to providers', async () => {
    localStorage.setItem('hermes_active_profile_name', 'research')
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        activeProvider: 'custom',
        settings: [
          {
            provider: 'openai',
            settings: { model: 'gpt-4o-transcribe', language: 'en' },
            secrets: { apiKey: '[stored]' },
            updatedAt: 1,
          },
        ],
      }),
    })

    const result = await fetchSttSettings()

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hermes.example/api/hermes/stt/settings',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          'Content-Type': 'application/json',
          'X-Hermes-Profile': 'research',
        }),
      }),
    )
    expect(result).toEqual({
      activeProvider: 'custom',
      providers: [
        {
          provider: 'openai',
          settings: { model: 'gpt-4o-transcribe', language: 'en' },
          secrets: { apiKey: '[stored]' },
          updatedAt: 1,
        },
      ],
    })
  })

  it('uses shared 401 handling for settings requests', async () => {
    localStorage.setItem('hermes_active_profile_name', 'research')
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve(''),
    })

    await expect(fetchSttSettings()).rejects.toThrow('Unauthorized')

    expect(hasApiKey()).toBe(false)
    expect(router.replace).toHaveBeenCalledWith({ name: 'login' })
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hermes.example/api/hermes/stt/settings',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          'X-Hermes-Profile': 'research',
        }),
      }),
    )
  })

  it('saves the active STT provider without a provider settings row', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ activeProvider: 'browser' }),
    })

    const result = await saveActiveSttProvider('browser')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hermes.example/api/hermes/stt/settings/active',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ provider: 'browser' }),
      }),
    )
    expect(result).toBe('browser')
  })

  it('saves masked stt settings and unwraps the response setting', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        setting: {
          provider: 'openai',
          settings: { model: 'gpt-4o-transcribe' },
          secrets: { apiKey: '[stored]' },
          updatedAt: 2,
        },
      }),
    })

    const result = await saveSttSettings('openai', {
      settings: { model: 'gpt-4o-transcribe' },
      secrets: { apiKey: 'new-secret' },
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hermes.example/api/hermes/stt/settings/openai',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          settings: { model: 'gpt-4o-transcribe' },
          secrets: { apiKey: 'new-secret' },
        }),
      }),
    )
    expect(result).toEqual({
      provider: 'openai',
      settings: { model: 'gpt-4o-transcribe' },
      secrets: { apiKey: '[stored]' },
      updatedAt: 2,
    })
  })

  it('clears stored api keys via the delete secret endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        setting: {
          provider: 'openai',
          settings: { model: 'gpt-4o-transcribe' },
          secrets: {},
          updatedAt: 3,
        },
      }),
    })

    const result = await clearSttSecret('openai', 'apiKey')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hermes.example/api/hermes/stt/settings/openai/secret/apiKey',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
        }),
      }),
    )
    expect(result).toEqual({
      provider: 'openai',
      settings: { model: 'gpt-4o-transcribe' },
      secrets: {},
      updatedAt: 3,
    })
  })

  it('deletes stored provider settings via the provider endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        deleted: true,
        activeProvider: 'browser',
      }),
    })

    const result = await deleteSttProvider('openai')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hermes.example/api/hermes/stt/settings/openai',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
        }),
      }),
    )
    expect(result).toEqual({
      success: true,
      deleted: true,
      activeProvider: 'browser',
    })
  })

  it('deletes saved base URL presets via the provider preset endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        setting: {
          provider: 'custom',
          settings: {
            baseUrl: 'https://stt.example.test/openai/v1',
            baseUrlPresets: ['https://stt.example.test/openai/v1'],
            model: 'whisper-large-v3-turbo',
          },
          secrets: { apiKey: '[stored]' },
          updatedAt: 4,
        },
      }),
    })

    const result = await deleteSttBaseUrlPreset('custom', 'https://api.groq.com/openai/v1')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hermes.example/api/hermes/stt/settings/custom/base-url-preset?url=https%3A%2F%2Fapi.groq.com%2Fopenai%2Fv1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
        }),
      }),
    )
    expect(result).toEqual({
      provider: 'custom',
      settings: {
        baseUrl: 'https://stt.example.test/openai/v1',
        baseUrlPresets: ['https://stt.example.test/openai/v1'],
        model: 'whisper-large-v3-turbo',
      },
      secrets: { apiKey: '[stored]' },
      updatedAt: 4,
    })
  })

  it('rejects transcription requests without a provider', async () => {
    await expect(transcribeSpeech({
      audio: new Blob(['audio'], { type: 'audio/webm' }),
    } as any)).rejects.toThrow('STT provider is required')

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('sends multipart transcription requests without serializing api keys or forcing JSON content type', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        text: 'transcribed text',
        provider: 'openai',
        model: 'gpt-4o-transcribe',
        language: 'en',
        durationMs: 42,
      }),
    })

    const result = await transcribeSpeech({
      audio: new Blob(['audio'], { type: 'audio/webm' }),
      provider: 'openai',
      language: 'en',
      prompt: 'keep punctuation',
      baseUrl: 'http://127.0.0.1:8000/v1/audio/transcriptions',
      apiKey: 'attacker-secret',
      secrets: { apiKey: 'body-secret' },
      headers: {
        Authorization: 'Bearer attacker-secret',
        'X-Api-Key': 'body-secret',
      },
    } as any)

    expect(result).toEqual({
      text: 'transcribed text',
      provider: 'openai',
      model: 'gpt-4o-transcribe',
      language: 'en',
      durationMs: 42,
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://hermes.example/api/hermes/stt/transcribe')
    expect(init.method).toBe('POST')
    expect(getHeader(init.headers, 'Authorization')).toBe('Bearer jwt-token')
    expect(getHeader(init.headers, 'Content-Type')).toBeUndefined()
    expect(init.body).toBeInstanceOf(FormData)

    const form = init.body as FormData
    expect(form.get('provider')).toBe('openai')
    expect(form.get('language')).toBe('en')
    expect(form.get('prompt')).toBe('keep punctuation')
    expect(form.get('baseUrl')).toBeNull()
    expect(form.get('apiKey')).toBeNull()
    expect(form.get('secrets')).toBeNull()
    expect(form.get('headers')).toBeNull()

    const keys = Array.from(form.keys())
    expect(keys).toEqual(expect.arrayContaining(['audio', 'provider', 'language', 'prompt']))
    expect(keys).not.toContain('baseUrl')
    expect(keys).not.toContain('apiKey')
    expect(keys).not.toContain('secrets')
    expect(keys).not.toContain('headers')

    const upload = form.get('audio')
    expect(upload).toBeInstanceOf(File)
    expect((upload as File).name).toBe('speech.webm')
    expect((upload as File).type).toBe('audio/webm')

    const serialized = JSON.stringify(Array.from(form.entries()).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? value
        : { name: value.name, type: value.type },
    ]))
    expect(serialized).not.toContain('attacker-secret')
    expect(serialized).not.toContain('body-secret')
    expect(serialized).not.toContain('127.0.0.1:8000')
  })

  it('does not persist raw STT API keys to localStorage when composable state changes', async () => {
    const { clearSttSettingsAuthState, useSttSettings } = await import('../../packages/client/src/composables/useSttSettings')

    clearSttSettingsAuthState()
    const settings = useSttSettings()

    settings.setOpenaiApiKey('openai-secret-sentinel')
    settings.setCustomApiKey('custom-secret-sentinel')
    settings.setOpenaiPrompt('transcribe carefully')
    settings.setCustomBaseUrl('https://transcribe.example.com/v1')
    await nextTick()

    const raw = localStorage.getItem('hermes-stt-settings-v1') || '{}'
    expect(raw).toContain('transcribe carefully')
    expect(raw).toContain('https://transcribe.example.com/v1')
    expect(raw).not.toContain('openai-secret-sentinel')
    expect(raw).not.toContain('custom-secret-sentinel')
  })

  it('uses shared 401 handling for transcription requests', async () => {
    localStorage.setItem('hermes_active_profile_name', 'research')
    const listener = vi.fn()
    window.addEventListener('hermes-auth-notice', listener)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve(''),
    })

    await expect(transcribeSpeech({
      audio: new Blob(['audio'], { type: 'audio/webm' }),
      provider: 'openai',
    })).rejects.toThrow('Unauthorized')

    expect(hasApiKey()).toBe(false)
    expect(router.replace).toHaveBeenCalledWith({ name: 'login' })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0].detail).toEqual({ kind: 'expired' })
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hermes.example/api/hermes/stt/transcribe',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          'X-Hermes-Profile': 'research',
        }),
      }),
    )

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(getHeader(init.headers, 'Content-Type')).toBeUndefined()
    expect(init.body).toBeInstanceOf(FormData)
    window.removeEventListener('hermes-auth-notice', listener)
  })
})

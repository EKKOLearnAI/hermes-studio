import { request } from '../client'
import type { TtsProviderId } from './tts'

export type StoredTtsProvider = TtsProviderId

export interface TtsStoredSettings {
  baseUrl?: string
  baseUrlPresets?: string[]
  model?: string
  voice?: string
  rate?: string
  pitch?: string
  authMode?: string
  voiceMode?: string
  voiceDesignDesc?: string
  voiceCloneFormat?: string
  stylePrompt?: string
}

export interface TtsStoredSecretsInput {
  apiKey?: string
}

export interface TtsStoredSecretsResponse {
  apiKey?: '[stored]'
}

export interface TtsProviderSettingsResponse {
  provider: StoredTtsProvider
  settings: TtsStoredSettings
  secrets: TtsStoredSecretsResponse
  createdAt?: number
  updatedAt: number
}

export interface FetchTtsSettingsResponse {
  providers: TtsProviderSettingsResponse[]
}

function normalizeProviders(body: unknown): FetchTtsSettingsResponse {
  if (body && typeof body === 'object') {
    const payload = body as { providers?: unknown; settings?: unknown }
    if (Array.isArray(payload.providers)) {
      return { providers: payload.providers as TtsProviderSettingsResponse[] }
    }
    if (Array.isArray(payload.settings)) {
      return { providers: payload.settings as TtsProviderSettingsResponse[] }
    }
  }
  return { providers: [] }
}

export async function fetchTtsSettings(): Promise<FetchTtsSettingsResponse> {
  const body = await request<{ providers?: TtsProviderSettingsResponse[]; settings?: TtsProviderSettingsResponse[] }>(
    '/api/hermes/tts/settings',
  )
  return normalizeProviders(body)
}

export async function saveTtsSettings(
  provider: StoredTtsProvider,
  payload: { settings?: TtsStoredSettings; secrets?: TtsStoredSecretsInput },
): Promise<TtsProviderSettingsResponse> {
  const body = await request<TtsProviderSettingsResponse | { setting: TtsProviderSettingsResponse }>(
    `/api/hermes/tts/settings/${provider}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  )
  return typeof body === 'object' && body !== null && 'setting' in body ? body.setting : body
}

export async function clearTtsSecret(
  provider: StoredTtsProvider,
  secretName: keyof TtsStoredSecretsInput,
): Promise<TtsProviderSettingsResponse | null> {
  const body = await request<
    TtsProviderSettingsResponse |
    { setting: TtsProviderSettingsResponse | null } |
    { success?: boolean; setting: TtsProviderSettingsResponse | null }
  >(
    `/api/hermes/tts/settings/${provider}/secret/${secretName}`,
    { method: 'DELETE' },
  )

  if (body && typeof body === 'object' && 'setting' in body) {
    return body.setting ?? null
  }
  return body as TtsProviderSettingsResponse
}

export async function deleteTtsBaseUrlPreset(
  provider: StoredTtsProvider,
  url: string,
): Promise<TtsProviderSettingsResponse | null> {
  const body = await request<
    { success?: boolean; setting: TtsProviderSettingsResponse | null } |
    TtsProviderSettingsResponse
  >(
    `/api/hermes/tts/settings/${provider}/base-url-preset?url=${encodeURIComponent(url)}`,
    { method: 'DELETE' },
  )

  if (body && typeof body === 'object' && 'setting' in body) {
    return body.setting ?? null
  }
  return body as TtsProviderSettingsResponse
}

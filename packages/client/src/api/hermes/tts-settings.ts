export type StoredTtsProvider = 'openai' | 'custom' | 'edge' | 'mimo'

export interface TtsStoredSettings {
  baseUrl?: string
  model?: string
  voice?: string
  rate?: string
  pitch?: string
  authMode?: 'api-key' | 'bearer' | 'both'
  voiceMode?: 'preset' | 'voiceDesign' | 'voiceClone'
  voiceDesignDesc?: string
  voiceCloneFormat?: 'mp3' | 'wav'
  stylePrompt?: string
}

export interface TtsStoredSecretsInput {
  apiKey?: string
  voiceCloneDataUri?: string
  voiceCloneFileName?: string
}

export interface TtsProviderSettingsResponse {
  provider: StoredTtsProvider
  settings: TtsStoredSettings
  secrets: Record<string, string>
  createdAt?: number
  updatedAt: number
}

function serverBaseUrl(): string {
  return localStorage.getItem('hermes_server_url') || ''
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('hermes_api_key') || ''}`,
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`TTS settings request failed: ${res.status}`)
  }
  return await res.json() as T
}

export async function fetchTtsSettings(): Promise<TtsProviderSettingsResponse[]> {
  const res = await fetch(`${serverBaseUrl()}/api/hermes/tts/settings`, {
    headers: authHeaders(),
  })
  const body = await parseJson<{ settings: TtsProviderSettingsResponse[] }>(res)
  return body.settings || []
}

export async function saveTtsSettings(
  provider: StoredTtsProvider,
  payload: { settings?: TtsStoredSettings; secrets?: TtsStoredSecretsInput },
): Promise<TtsProviderSettingsResponse> {
  const res = await fetch(`${serverBaseUrl()}/api/hermes/tts/settings/${provider}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  const body = await parseJson<TtsProviderSettingsResponse | { setting: TtsProviderSettingsResponse }>(res)
  return 'setting' in body ? body.setting : body
}

export async function clearTtsSecret(
  provider: StoredTtsProvider,
  secretName: keyof TtsStoredSecretsInput,
): Promise<TtsProviderSettingsResponse | null> {
  const res = await fetch(`${serverBaseUrl()}/api/hermes/tts/settings/${provider}/secret/${secretName}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  const body = await parseJson<{ setting?: TtsProviderSettingsResponse | null } | TtsProviderSettingsResponse>(res)
  return body && typeof body === 'object' && 'setting' in body ? body.setting ?? null : body as TtsProviderSettingsResponse
}

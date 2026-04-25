import { request } from '../client'

export interface HealthResponse {
  status: string
  version?: string
  webui_version?: string
  webui_latest?: string
  webui_update_available?: boolean
  node_version?: string
}

// Config-based model types
export interface ModelInfo {
  id: string
  label: string
}

export interface ModelGroup {
  provider: string
  models: ModelInfo[]
}

export interface ConfigModelsResponse {
  default: string
  groups: ModelGroup[]
}

export interface AvailableModelGroup {
  provider: string   // credential pool key (e.g. "zai", "custom:subrouter.ai")
  label: string      // display name (e.g. "zai", "subrouter.ai")
  base_url: string
  models: string[]
  api_key: string
}

export interface AvailableModelsResponse {
  default: string
  default_provider: string
  groups: AvailableModelGroup[]
  allProviders: AvailableModelGroup[]
}

export interface CustomProvider {
  name: string
  base_url: string
  api_key: string
  model: string
  context_length?: number
  providerKey?: string | null
}

export async function checkHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health', { forceLocal: true })
}

export async function triggerUpdate(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('/api/hermes/update', { method: 'POST', forceLocal: true })
}

export async function fetchConfigModels(): Promise<ConfigModelsResponse> {
  return request<ConfigModelsResponse>('/api/hermes/config/models', { forceLocal: true })
}

export async function fetchAvailableModels(): Promise<AvailableModelsResponse> {
  return request<AvailableModelsResponse>('/api/hermes/available-models', { forceLocal: true })
}

export async function updateDefaultModel(data: {
  default: string
  provider?: string
  base_url?: string
  api_key?: string
}): Promise<void> {
  await request('/api/hermes/config/model', {
    method: 'PUT',
    body: JSON.stringify(data),
    forceLocal: true,
  })
}

export async function addCustomProvider(data: CustomProvider): Promise<void> {
  await request('/api/hermes/config/providers', {
    method: 'POST',
    body: JSON.stringify(data),
    forceLocal: true,
  })
}

export async function removeCustomProvider(name: string): Promise<void> {
  await request(`/api/hermes/config/providers/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    forceLocal: true,
  })
}

export async function updateProvider(poolKey: string, data: {
  name?: string
  base_url?: string
  api_key?: string
  model?: string
}): Promise<void> {
  await request(`/api/hermes/config/providers/${encodeURIComponent(poolKey)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
    forceLocal: true,
  })
}

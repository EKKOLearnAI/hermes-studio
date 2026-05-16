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

export interface ModelVisibilityRule {
  mode: 'all' | 'include'
  models: string[]
}

export type ModelVisibility = Record<string, ModelVisibilityRule>

export interface AvailableModelGroup {
  provider: string   // credential pool key (e.g. "zai", "custom:subrouter.ai")
  label: string      // display name (e.g. "zai", "subrouter.ai")
  base_url: string
  models: string[]
  /** Full unfiltered model catalog for this provider, used to restore hidden WUI models. */
  available_models?: string[]
  api_key: string
  builtin?: boolean
  /** 可选：模型 ID -> 元数据（preview/disabled/alias）。alias 仅用于 Web UI 展示。 */
  model_meta?: Record<string, { preview?: boolean; disabled?: boolean; alias?: string }>
}

export interface AvailableModelsResponse {
  default: string
  default_provider: string
  groups: AvailableModelGroup[]
  allProviders: AvailableModelGroup[]
  /** Web UI-only display aliases keyed by provider -> canonical model ID. */
  model_aliases?: Record<string, Record<string, string>>
  model_visibility?: ModelVisibility
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
  return request<HealthResponse>('/health')
}

export async function triggerUpdate(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('/api/hermes/update', { method: 'POST' })
}

export async function fetchConfigModels(): Promise<ConfigModelsResponse> {
  return request<ConfigModelsResponse>('/api/hermes/config/models')
}

export async function fetchAvailableModels(): Promise<AvailableModelsResponse> {
  return request<AvailableModelsResponse>('/api/hermes/available-models')
}

export async function fetchProviderModels(data: {
  base_url: string
  api_key?: string
  freeOnly?: boolean
}): Promise<{ models: string[] }> {
  return request<{ models: string[] }>('/api/hermes/provider-models', {
    method: 'POST',
    body: JSON.stringify(data),
  })
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
  })
}

export async function updateModelAlias(data: {
  provider: string
  model: string
  alias: string
}): Promise<void> {
  await request('/api/hermes/model-alias', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function addCustomProvider(data: CustomProvider): Promise<void> {
  await request('/api/hermes/config/providers', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function removeCustomProvider(name: string): Promise<void> {
  await request(`/api/hermes/config/providers/${encodeURIComponent(name)}`, {
    method: 'DELETE',
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
  })
}

export async function updateModelVisibility(data: {
  provider: string
  mode: 'all' | 'include'
  models: string[]
}): Promise<{ success: boolean; model_visibility: ModelVisibility }> {
  return request<{ success: boolean; model_visibility: ModelVisibility }>('/api/hermes/model-visibility', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

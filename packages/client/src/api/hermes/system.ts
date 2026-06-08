import { request } from '../client'

export interface HealthResponse {
  status: string
  platform?: string
  version?: string
  gateway?: string
  webui_version?: string
  webui_latest?: string
  webui_update_available?: boolean
  node_version?: string
  agent_bridge?: {
    status: string
    reachable: boolean
    ready?: boolean
    running?: boolean
    attached?: boolean
    starting?: boolean
    stopping?: boolean
    restart_scheduled?: boolean
    restart_attempts?: number
    endpoint_kind?: 'ipc' | 'tcp' | 'unknown'
    pid?: number
    error?: string
  }
}

export interface PreviewTag {
  name: string
  sha: string
}

export interface PreviewStatus {
  preview_dir: string
  exists: boolean
  has_package: boolean
  installed: boolean
  running: boolean
  pid: number | null
  current_tag: string
  frontend_url: string
  agent_bridge_endpoint: string
  log_path: string
  webui_home: string
  action_log_path: string
  dev_log_path: string
  active_action: string | null
  active_action_started_at: string | null
  last_action: string | null
  last_action_completed_at: string | null
  last_action_success: boolean | null
  last_action_message: string
  last_action_code: string
  action_log: string
  dev_log: string
}

export interface PreviewActionResponse extends PreviewStatus {
  success: boolean
  accepted?: boolean
  message?: string
  code?: string
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
export type CustomModels = Record<string, string[]>

export interface AvailableModelGroup {
  provider: string   // credential pool key (e.g. "zai", "custom:subrouter.ai")
  label: string      // display name (e.g. "zai", "subrouter.ai")
  base_url: string
  models: string[]
  /** Full unfiltered model catalog for this provider, used to restore hidden WUI models. */
  available_models?: string[]
  api_key: string
  api_mode?: 'chat_completions' | 'codex_responses' | 'anthropic_messages'
  builtin?: boolean
  /** Env var used by Hermes to override this provider's base URL. If present, the preset URL is editable. */
  base_url_env?: string
  /** 可选：模型 ID -> 元数据（preview/disabled/alias）。alias 仅用于 Web UI 展示。 */
  model_meta?: Record<string, { preview?: boolean; disabled?: boolean; alias?: string }>
}

export interface ProfileAvailableModels {
  profile: string
  default: string
  default_provider: string
  groups: AvailableModelGroup[]
}

export interface AvailableModelsResponse {
  default: string
  default_provider: string
  groups: AvailableModelGroup[]
  allProviders: AvailableModelGroup[]
  profiles?: ProfileAvailableModels[]
  /** Web UI-only display aliases keyed by provider -> canonical model ID. */
  model_aliases?: Record<string, Record<string, string>>
  model_visibility?: ModelVisibility
  custom_models?: CustomModels
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

export async function fetchPreviewStatus(): Promise<PreviewStatus> {
  return request<PreviewStatus>('/api/hermes/update/preview')
}

export async function fetchPreviewTags(): Promise<{ tags: PreviewTag[] }> {
  return request<{ tags: PreviewTag[] }>('/api/hermes/update/preview/tags')
}

export async function preparePreview(tag: string): Promise<PreviewActionResponse> {
  return request<PreviewActionResponse>('/api/hermes/update/preview/prepare', {
    method: 'POST',
    body: JSON.stringify({ tag }),
  })
}

export async function installPreview(): Promise<PreviewActionResponse> {
  return request<PreviewActionResponse>('/api/hermes/update/preview/install', { method: 'POST' })
}

export async function startPreview(tag?: string): Promise<PreviewActionResponse> {
  return request<PreviewActionResponse>('/api/hermes/update/preview/start', {
    method: 'POST',
    body: JSON.stringify({ tag }),
  })
}

export async function stopPreview(): Promise<PreviewActionResponse> {
  return request<PreviewActionResponse>('/api/hermes/update/preview/stop', { method: 'POST' })
}

export async function fetchConfigModels(): Promise<ConfigModelsResponse> {
  return request<ConfigModelsResponse>('/api/hermes/config/models')
}

export async function fetchAvailableModels(): Promise<AvailableModelsResponse> {
  return request<AvailableModelsResponse>('/api/hermes/available-models')
}

export async function fetchAvailableModelsForProfile(profile: string): Promise<AvailableModelsResponse> {
  const params = new URLSearchParams()
  params.set('profile', profile || 'default')
  return request<AvailableModelsResponse>(`/api/hermes/available-models?${params.toString()}`)
}

export async function fetchProviderModels(data: {
  base_url: string
  api_key?: string
  freeOnly?: boolean
  provider?: string
  label?: string
  update_cache?: boolean
}): Promise<{ models: string[] }> {
  return request<{ models: string[] }>('/api/hermes/provider-models', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function refreshProviderModelCache(): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/api/hermes/provider-models/cache/refresh', {
    method: 'POST',
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

export async function addCustomModel(data: {
  provider: string
  model: string
}): Promise<{ success: boolean; custom_models: CustomModels }> {
  return request<{ success: boolean; custom_models: CustomModels }>('/api/hermes/custom-model', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function removeCustomModel(data: {
  provider: string
  model: string
}): Promise<{ success: boolean; custom_models: CustomModels }> {
  const params = new URLSearchParams()
  params.set('provider', data.provider)
  params.set('model', data.model)
  return request<{ success: boolean; custom_models: CustomModels }>(`/api/hermes/custom-model?${params.toString()}`, {
    method: 'DELETE',
  })
}

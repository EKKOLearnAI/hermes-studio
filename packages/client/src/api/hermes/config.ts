import { request } from '../client'

export interface DisplayConfig {
  compact?: boolean
  personality?: string
  resume_display?: string
  busy_input_mode?: string
  chat_input_height?: number | null
  bell_on_complete?: boolean
  notify_on_complete?: boolean
  show_reasoning?: boolean
  streaming?: boolean
  inline_diffs?: boolean
  show_cost?: boolean
  skin?: string
}

export interface AgentConfig {
  max_turns?: number
  gateway_timeout?: number
  restart_drain_timeout?: number
  service_tier?: string
  tool_use_enforcement?: string
}

export interface MemoryConfig {
  memory_enabled?: boolean
  user_profile_enabled?: boolean
  memory_char_limit?: number
  user_char_limit?: number
  write_approval?: boolean
}

export interface SkillsConfig {
  write_approval?: boolean
}

export interface CompressionConfig {
  enabled?: boolean
  threshold?: number
  target_ratio?: number
  protect_last_n?: number
  protect_first_n?: number
}

export interface SessionResetConfig {
  mode?: string
  idle_minutes?: number
  at_hour?: number
}

export interface PrivacyConfig {
  redact_pii?: boolean
}

export interface ApprovalConfig {
  mode?: 'off' | 'manual'
  timeout?: number
}

export interface GatewayAutoStartConfig {
  enabled?: boolean
  include?: string[]
  exclude?: string[]
  management?: 'auto' | 'per_profile' | 'unified'
}

export interface ProxyConfig {
  HTTPS_PROXY?: string
  HTTP_PROXY?: string
  ALL_PROXY?: string
  NO_PROXY?: string
}

export interface AppConfig {
  display?: DisplayConfig
  agent?: AgentConfig
  memory?: MemoryConfig
  skills?: SkillsConfig
  compression?: CompressionConfig
  session_reset?: SessionResetConfig
  privacy?: PrivacyConfig
  approvals?: ApprovalConfig
  gatewayAutoStart?: GatewayAutoStartConfig
  proxy?: ProxyConfig
  telegram?: Record<string, any>
  discord?: Record<string, any>
  slack?: Record<string, any>
  whatsapp?: Record<string, any>
  matrix?: Record<string, any>
  weixin?: Record<string, any>
  wecom?: Record<string, any>
  feishu?: Record<string, any>
  dingtalk?: Record<string, any>
  qqbot?: Record<string, any>
  platforms?: Record<string, any>
  [key: string]: any
}

export interface AuxiliaryModelTask {
  key: string
  label: string
  default_timeout?: number
  default_download_timeout?: number
}

export interface AuxiliaryModelSettings {
  provider?: string
  model?: string
  base_url?: string
  api_key?: string
  timeout?: number
  download_timeout?: number
  extra_body?: Record<string, any>
}

export type AuxiliaryModelsConfig = Record<string, AuxiliaryModelSettings>

export interface AuxiliaryModelsResponse {
  tasks: AuxiliaryModelTask[]
  auxiliary: AuxiliaryModelsConfig
}

export interface MoaModelSlot {
  provider: string
  model: string
}

export interface MoaPreset {
  enabled: boolean
  reference_models: MoaModelSlot[]
  aggregator: MoaModelSlot
  reference_temperature: number
  aggregator_temperature: number
  max_tokens: number
}

export interface MoaConfig {
  default_preset: string
  active_preset?: string
  presets: Record<string, MoaPreset>
  reference_models: MoaModelSlot[]
  aggregator: MoaModelSlot
  reference_temperature: number
  aggregator_temperature: number
  max_tokens: number
  enabled: boolean
}

export async function fetchConfig(sections?: string[]): Promise<AppConfig> {
  const query = sections ? `?sections=${sections.join(',')}` : ''
  return request<AppConfig>(`/api/hermes/config${query}`)
}

export async function updateConfigSection(
  section: string,
  values: Record<string, any>,
  options?: { restart?: boolean },
): Promise<void> {
  await request('/api/hermes/config', {
    method: 'PUT',
    body: JSON.stringify({ section, values, ...options }),
  })
}

export async function fetchAuxiliaryModels(): Promise<AuxiliaryModelsResponse> {
  return request<AuxiliaryModelsResponse>('/api/hermes/config/auxiliary-models')
}

export async function saveAuxiliaryModels(auxiliary: AuxiliaryModelsConfig): Promise<{
  success: boolean
  auxiliary: AuxiliaryModelsConfig
}> {
  return request<{ success: boolean; auxiliary: AuxiliaryModelsConfig }>('/api/hermes/config/auxiliary-models', {
    method: 'PUT',
    body: JSON.stringify({ auxiliary }),
  })
}

export async function fetchMoaConfig(): Promise<MoaConfig> {
  return request<MoaConfig>('/api/hermes/config/moa')
}

export async function saveMoaConfig(moa: MoaConfig): Promise<{
  success: boolean
  moa: MoaConfig
}> {
  return request<{ success: boolean; moa: MoaConfig }>('/api/hermes/config/moa', {
    method: 'PUT',
    body: JSON.stringify({ moa }),
  })
}

export async function saveCredentials(
  platform: string,
  values: Record<string, any>,
): Promise<void> {
  await request('/api/hermes/config/credentials', {
    method: 'PUT',
    body: JSON.stringify({ platform, values }),
  })
}

export interface WeixinQrCode {
  qrcode: string
  qrcode_url: string
}

export interface WeixinQrStatus {
  status: 'wait' | 'scaned' | 'scaned_but_redirect' | 'expired' | 'confirmed'
  account_id?: string
  token?: string
  base_url?: string
}

export async function fetchWeixinQrCode(): Promise<WeixinQrCode> {
  return request<WeixinQrCode>('/api/hermes/weixin/qrcode')
}

export async function pollWeixinQrStatus(qrcode: string): Promise<WeixinQrStatus> {
  return request<WeixinQrStatus>(`/api/hermes/weixin/qrcode/status?qrcode=${encodeURIComponent(qrcode)}`)
}

export async function saveWeixinCredentials(data: {
  account_id: string
  token: string
  base_url?: string
}): Promise<void> {
  await request('/api/hermes/weixin/save', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

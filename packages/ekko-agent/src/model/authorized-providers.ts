import type { ModelRequestStyle } from './types'

export type AuthorizedModelProviderId = 'nous' | 'openai-codex' | 'xai-oauth' | 'qwen-oauth'

export interface AuthorizedModelProviderPreset {
  id: AuthorizedModelProviderId
  baseUrl: string
  requestStyle: ModelRequestStyle
  headers: Record<string, string>
}

const AUTHORIZED_PROVIDER_ALIASES: Record<string, AuthorizedModelProviderId> = {
  nous: 'nous',
  'openai-codex': 'openai-codex',
  codex: 'openai-codex',
  'xai-oauth': 'xai-oauth',
  'x-ai-oauth': 'xai-oauth',
  'grok-oauth': 'xai-oauth',
  'qwen-oauth': 'qwen-oauth',
  'qwen-portal': 'qwen-oauth',
}

export function authorizedModelProviderId(provider: string): AuthorizedModelProviderId | undefined {
  return AUTHORIZED_PROVIDER_ALIASES[String(provider || '').trim().toLowerCase()]
}

export function authorizedModelProviderPreset(
  provider: string,
  accessToken?: string,
): AuthorizedModelProviderPreset | undefined {
  const id = authorizedModelProviderId(provider)
  if (!id) return undefined

  if (id === 'nous') {
    return {
      id,
      baseUrl: 'https://inference-api.nousresearch.com/v1',
      requestStyle: 'openai-chat',
      headers: {},
    }
  }
  if (id === 'openai-codex') {
    return {
      id,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      requestStyle: 'openai-responses',
      headers: codexHeaders(accessToken),
    }
  }
  if (id === 'xai-oauth') {
    return {
      id,
      baseUrl: 'https://api.x.ai/v1',
      requestStyle: 'openai-responses',
      headers: {},
    }
  }
  return {
    id,
    baseUrl: 'https://portal.qwen.ai/v1',
    requestStyle: 'openai-chat',
    headers: qwenHeaders(),
  }
}

function codexHeaders(accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': 'codex_cli_rs/0.0.0 (Ekko Agent)',
    originator: 'codex_cli_rs',
  }
  const accountId = chatGptAccountId(accessToken)
  if (accountId) headers['ChatGPT-Account-ID'] = accountId
  return headers
}

function qwenHeaders(): Record<string, string> {
  const userAgent = `QwenCode/0.14.1 (${runtimePlatform()}; ${runtimeArchitecture()})`
  return {
    'user-agent': userAgent,
    'X-DashScope-CacheControl': 'enable',
    'X-DashScope-UserAgent': userAgent,
    'X-DashScope-AuthType': 'qwen-oauth',
  }
}

function chatGptAccountId(accessToken?: string): string | undefined {
  if (!accessToken) return undefined
  const payload = accessToken.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = claims['https://api.openai.com/auth']
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return undefined
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id
    return typeof accountId === 'string' && accountId ? accountId : undefined
  } catch {
    return undefined
  }
}

function runtimePlatform(): string {
  return typeof process !== 'undefined' ? process.platform : 'unknown'
}

function runtimeArchitecture(): string {
  return typeof process !== 'undefined' ? process.arch : 'unknown'
}

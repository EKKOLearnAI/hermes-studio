import {
  AgentBridgeClient,
  type AgentBridgeProviderCredentials,
} from '../bridge/client'
import { getAgentBridgeManager } from '../bridge/manager'

const DEFAULT_TIMEOUT_MS = 30_000

export const AUTHORIZED_RUNTIME_PROVIDERS = new Set([
  'nous',
  'openai-codex',
  'xai-oauth',
  'qwen-oauth',
  'claude-oauth',
  'minimax-oauth',
])

export interface AuthorizedProviderRuntimeCredentials {
  provider: string
  apiKey: string
  baseUrl?: string
  apiMode?: string
  source?: string
  lastRefresh?: string
  expiresAt?: string
  expiresAtMs?: number
}

export class AuthorizedProviderCredentialError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly code = 'AUTHORIZED_PROVIDER_CREDENTIAL_FAILED',
    readonly reloginRequired = false,
  ) {
    super(message)
  }
}

interface ResolverDependencies {
  request?: (
    profile: string,
    provider: string,
    model?: string,
  ) => Promise<AgentBridgeProviderCredentials>
}

async function requestProviderCredentials(
  profile: string,
  provider: string,
  model?: string,
): Promise<AgentBridgeProviderCredentials> {
  const manager = getAgentBridgeManager()
  await manager.start()
  const client = new AgentBridgeClient({
    endpoint: manager.endpoint,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    connectRetryMs: 5_000,
  })
  return client.providerCredentials(profile, provider, model)
}

export function isAuthorizedRuntimeProvider(provider: unknown): boolean {
  return AUTHORIZED_RUNTIME_PROVIDERS.has(String(provider || '').trim().toLowerCase())
}

export async function resolveAuthorizedProviderRuntimeCredentials(
  input: { profile: string; provider: string; model?: string },
  dependencies: ResolverDependencies = {},
): Promise<AuthorizedProviderRuntimeCredentials> {
  const provider = String(input.provider || '').trim().toLowerCase()
  if (!isAuthorizedRuntimeProvider(provider)) {
    throw new AuthorizedProviderCredentialError(
      `Provider "${provider}" is not managed by Hermes authorization`,
      provider,
      'AUTHORIZED_PROVIDER_UNSUPPORTED',
    )
  }

  const profile = String(input.profile || '').trim() || 'default'
  const payload = await (dependencies.request || requestProviderCredentials)(
    profile,
    provider,
    input.model?.trim() || undefined,
  )
  if (!payload.resolved) {
    throw new AuthorizedProviderCredentialError(
      payload.error || `Hermes Agent could not refresh ${provider} credentials`,
      provider,
      payload.code || 'AUTHORIZED_PROVIDER_REFRESH_FAILED',
      payload.relogin_required === true,
    )
  }

  const apiKey = String(payload.api_key || '').trim()
  if (!apiKey) {
    throw new AuthorizedProviderCredentialError(
      `Hermes Agent returned no access token for ${provider}`,
      provider,
      'AUTHORIZED_PROVIDER_EMPTY_TOKEN',
    )
  }

  return {
    provider: String(payload.provider || provider),
    apiKey,
    ...(payload.base_url ? { baseUrl: String(payload.base_url).replace(/\/+$/, '') } : {}),
    ...(payload.api_mode ? { apiMode: String(payload.api_mode) } : {}),
    ...(payload.source ? { source: String(payload.source) } : {}),
    ...(payload.last_refresh ? { lastRefresh: String(payload.last_refresh) } : {}),
    ...(payload.expires_at ? { expiresAt: String(payload.expires_at) } : {}),
    ...(Number.isFinite(payload.expires_at_ms) ? { expiresAtMs: Number(payload.expires_at_ms) } : {}),
  }
}

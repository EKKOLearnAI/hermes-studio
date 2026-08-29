import type {
  EkkoConfig,
  EkkoModelAuthorizationSettings,
  EkkoModelProviderSettings,
} from '../config'
import type {
  ConfiguredModelAuthorizationEntry,
  EkkoConfigStore,
} from '../config-store'
import type { EkkoModelApiMode } from './provider-presets'
import type { FetchLike } from './types'

export interface EkkoModelAuthorizationCredentials {
  provider: string
  accessToken: string
  expiresAt?: string
  baseUrl?: string
  apiMode?: EkkoModelApiMode
}

export interface EkkoModelAuthorizationRefreshInput {
  provider: string
  model?: string
  authorization: EkkoModelAuthorizationSettings
  providerSettings: EkkoModelProviderSettings
}

export interface EkkoModelAuthorizationRefreshResult {
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  expiresIn?: number
  baseUrl?: string
  apiMode?: EkkoModelApiMode
}

export type EkkoModelAuthorizationRefresher = (
  input: EkkoModelAuthorizationRefreshInput,
) => Promise<EkkoModelAuthorizationRefreshResult>

export interface EkkoModelAuthorizationManagerOptions {
  config: EkkoConfigStore
  refresher?: EkkoModelAuthorizationRefresher
  fetch?: FetchLike
  now?: () => number
}

export class EkkoModelAuthorizationError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly code = 'MODEL_AUTHORIZATION_FAILED',
    readonly reloginRequired = false,
  ) {
    super(message)
    this.name = 'EkkoModelAuthorizationError'
  }
}

/**
 * Owns persisted OAuth records and resolves a fresh access token before model
 * requests. Concurrent refreshes for one provider share the same promise.
 */
export class EkkoModelAuthorizationManager {
  private readonly config: EkkoConfigStore
  private readonly refresher?: EkkoModelAuthorizationRefresher
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly refreshes = new Map<string, Promise<EkkoModelAuthorizationCredentials>>()

  constructor(options: EkkoModelAuthorizationManagerOptions) {
    this.config = options.config
    this.refresher = options.refresher
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = options.now ?? Date.now
  }

  list(): ConfiguredModelAuthorizationEntry[] {
    return this.config.listModelAuthorizations()
  }

  get(provider: string): EkkoModelAuthorizationSettings | undefined {
    return this.config.getModelAuthorization(provider)
  }

  set(provider: string, settings: EkkoModelAuthorizationSettings): EkkoConfig {
    return this.config.setModelAuthorization(provider, settings)
  }

  update(provider: string, patch: Partial<EkkoModelAuthorizationSettings>): EkkoConfig {
    return this.config.updateModelAuthorization(provider, patch)
  }

  delete(provider: string): boolean {
    return this.config.deleteModelAuthorization(provider)
  }

  needsRefresh(provider: string): boolean {
    const normalizedProvider = normalizeProvider(provider)
    const config = this.config.read()
    const authorization = config.model.authorizations[normalizedProvider]
    if (!authorization?.accessToken) return true
    if (!authorization.expiresAt) return false
    return Date.parse(authorization.expiresAt) - this.now() <= config.model.authorizationRefreshLeewayMs
  }

  async resolve(provider: string, model?: string): Promise<EkkoModelAuthorizationCredentials> {
    const normalizedProvider = normalizeProvider(provider)
    const config = this.config.read()
    const providerSettings = config.model.providers[normalizedProvider]
    if (!providerSettings) {
      throw new EkkoModelAuthorizationError(
        `Configured model provider not found: ${normalizedProvider}`,
        normalizedProvider,
        'MODEL_AUTHORIZATION_PROVIDER_NOT_FOUND',
      )
    }
    const authorization = config.model.authorizations[normalizedProvider]
    if (!authorization) {
      throw new EkkoModelAuthorizationError(
        `Model provider ${normalizedProvider} is not authorized.`,
        normalizedProvider,
        'MODEL_AUTHORIZATION_MISSING',
        true,
      )
    }

    if (!this.needsRefresh(normalizedProvider)) {
      return credentialsFromAuthorization(normalizedProvider, authorization)
    }
    return this.refresh(normalizedProvider, model)
  }

  async refresh(provider: string, model?: string): Promise<EkkoModelAuthorizationCredentials> {
    const normalizedProvider = normalizeProvider(provider)
    const active = this.refreshes.get(normalizedProvider)
    if (active) return active

    const refresh = this.performRefresh(normalizedProvider, model)
      .finally(() => this.refreshes.delete(normalizedProvider))
    this.refreshes.set(normalizedProvider, refresh)
    return refresh
  }

  private async performRefresh(
    provider: string,
    model?: string,
  ): Promise<EkkoModelAuthorizationCredentials> {
    const config = this.config.read()
    const providerSettings = config.model.providers[provider]
    const authorization = config.model.authorizations[provider]
    if (!providerSettings) {
      throw new EkkoModelAuthorizationError(
        `Configured model provider not found: ${provider}`,
        provider,
        'MODEL_AUTHORIZATION_PROVIDER_NOT_FOUND',
      )
    }
    if (!authorization) {
      throw new EkkoModelAuthorizationError(
        `Model provider ${provider} is not authorized.`,
        provider,
        'MODEL_AUTHORIZATION_MISSING',
        true,
      )
    }

    let refreshed: EkkoModelAuthorizationRefreshResult
    try {
      refreshed = this.refresher
        ? await this.refresher({
            provider,
            model,
            authorization: structuredClone(authorization),
            providerSettings: structuredClone(providerSettings),
          })
        : await refreshStandardOAuthToken(provider, authorization, this.fetchImpl)
    } catch (error) {
      if (error instanceof EkkoModelAuthorizationError) throw error
      throw new EkkoModelAuthorizationError(
        `Could not refresh ${provider} authorization: ${error instanceof Error ? error.message : String(error)}`,
        provider,
        'MODEL_AUTHORIZATION_REFRESH_FAILED',
      )
    }

    const accessToken = String(refreshed.accessToken || '').trim()
    if (!accessToken) {
      throw new EkkoModelAuthorizationError(
        `Authorization refresh returned no access token for ${provider}.`,
        provider,
        'MODEL_AUTHORIZATION_EMPTY_TOKEN',
        true,
      )
    }
    const now = this.now()
    const expiresAt = refreshed.expiresAt
      ? normalizeExpiry(refreshed.expiresAt, provider)
      : Number.isFinite(refreshed.expiresIn) && Number(refreshed.expiresIn) > 0
        ? new Date(now + Number(refreshed.expiresIn) * 1_000).toISOString()
        : undefined
    const next: EkkoModelAuthorizationSettings = {
      ...authorization,
      accessToken,
      refreshToken: String(refreshed.refreshToken || authorization.refreshToken || '').trim() || undefined,
      obtainedAt: new Date(now).toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
      ...(refreshed.baseUrl ? { baseUrl: String(refreshed.baseUrl).trim() } : {}),
      ...(refreshed.apiMode ? { apiMode: refreshed.apiMode } : {}),
    }
    if (!expiresAt) delete next.expiresAt
    this.config.setModelAuthorization(provider, next)
    return credentialsFromAuthorization(provider, next)
  }
}

export async function refreshStandardOAuthToken(
  provider: string,
  authorization: EkkoModelAuthorizationSettings,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<EkkoModelAuthorizationRefreshResult> {
  const tokenUrl = String(authorization.tokenUrl || '').trim()
  const refreshToken = String(authorization.refreshToken || '').trim()
  if (!tokenUrl || !refreshToken) {
    throw new EkkoModelAuthorizationError(
      `Model provider ${provider} requires a host refresher or tokenUrl and refreshToken.`,
      provider,
      'MODEL_AUTHORIZATION_REFRESH_UNAVAILABLE',
      !refreshToken,
    )
  }

  const body = new URLSearchParams(authorization.tokenParams || {})
  body.set('grant_type', 'refresh_token')
  body.set('refresh_token', refreshToken)
  if (authorization.clientId) body.set('client_id', authorization.clientId)
  if (authorization.clientSecret) body.set('client_secret', authorization.clientSecret)
  if (authorization.scope) body.set('scope', authorization.scope)

  const response = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const oauthCode = String(payload.error || '').trim()
    const detail = String(payload.error_description || payload.message || oauthCode || `HTTP ${response.status}`).trim()
    throw new EkkoModelAuthorizationError(
      `OAuth refresh failed for ${provider}: ${detail}`,
      provider,
      oauthCode || 'MODEL_AUTHORIZATION_REFRESH_FAILED',
      oauthCode === 'invalid_grant' || oauthCode === 'invalid_token',
    )
  }

  return {
    accessToken: String(payload.access_token || ''),
    ...(payload.refresh_token ? { refreshToken: String(payload.refresh_token) } : {}),
    ...(Number.isFinite(Number(payload.expires_in)) ? { expiresIn: Number(payload.expires_in) } : {}),
  }
}

function credentialsFromAuthorization(
  provider: string,
  authorization: EkkoModelAuthorizationSettings,
): EkkoModelAuthorizationCredentials {
  const accessToken = String(authorization.accessToken || '').trim()
  if (!accessToken) {
    throw new EkkoModelAuthorizationError(
      `Model provider ${provider} authorization has no access token.`,
      provider,
      'MODEL_AUTHORIZATION_EMPTY_TOKEN',
      true,
    )
  }
  return {
    provider,
    accessToken,
    ...(authorization.expiresAt ? { expiresAt: authorization.expiresAt } : {}),
    ...(authorization.baseUrl ? { baseUrl: authorization.baseUrl } : {}),
    ...(authorization.apiMode ? { apiMode: authorization.apiMode } : {}),
  }
}

function normalizeProvider(provider: string): string {
  const normalized = String(provider || '').trim()
  if (!normalized) throw new EkkoModelAuthorizationError('Model provider is required.', '')
  return normalized
}

function normalizeExpiry(value: string, provider: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw new EkkoModelAuthorizationError(
      `Authorization refresh returned an invalid expiresAt for ${provider}.`,
      provider,
      'MODEL_AUTHORIZATION_INVALID_EXPIRY',
    )
  }
  return new Date(timestamp).toISOString()
}

import {
  isAuthorizedRuntimeProvider,
  resolveAuthorizedProviderRuntimeCredentials,
} from '../hermes/authorized-provider-credentials'

export interface EkkoAuthorizedProviderCredentials {
  apiKey?: string
  baseUrl?: string
  apiMode?: string
}

export async function resolveEkkoAuthorizedProviderCredentials(
  profile: string,
  provider: string,
  model?: string,
): Promise<EkkoAuthorizedProviderCredentials> {
  if (!isAuthorizedRuntimeProvider(provider)) return {}

  const credentials = await resolveAuthorizedProviderRuntimeCredentials({
    profile,
    provider,
    model,
  })
  return {
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
    apiMode: credentials.apiMode,
  }
}

export type AppAccessMode = 'internal' | 'public_beta' | 'paid'

type AppAuthConfigResponse = {
  accessMode?: unknown
}

export function isAppAccessMode(value: unknown): value is AppAccessMode {
  return value === 'internal' || value === 'public_beta' || value === 'paid'
}

export async function fetchAppAccessMode(
  relayUrl: string,
  request: typeof fetch = fetch,
): Promise<AppAccessMode | null> {
  try {
    const baseUrl = relayUrl.replace(/\/+$/, '')
    const response = await request(`${baseUrl}/api/app/auth/config`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return null

    const payload = await response.json() as AppAuthConfigResponse
    return isAppAccessMode(payload.accessMode) ? payload.accessMode : null
  } catch {
    // The purchase entry must remain hidden when the remote access mode is unavailable.
    return null
  }
}

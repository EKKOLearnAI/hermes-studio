import {
  ensureDesktopAuthReady,
  getApiKey,
  getBaseUrlValue,
  request,
} from './client'

export interface UserThemeSettings {
  fontSize: number
  textColor: string | null
  accentColor: string | null
  background: {
    name: string
    mime: string | null
    updatedAt: number
  } | null
  updatedAt: number
}

const BACKGROUND_CACHE_NAME = 'hermes-theme-background-v1'

function backgroundCacheKey(userId: number, version: number): string {
  const origin = typeof window === 'undefined' ? 'http://hermes.local' : window.location.origin
  return new URL(`/__hermes-theme-background/${userId}/${version}`, origin).toString()
}

async function themeFetch(path: string, options: RequestInit = {}): Promise<Response> {
  await ensureDesktopAuthReady()
  const headers = new Headers(options.headers)
  const token = getApiKey()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(`${getBaseUrlValue()}${path}`, { ...options, headers })
}

export function fetchThemeSettings(): Promise<UserThemeSettings> {
  return request<UserThemeSettings>('/api/theme')
}

export function updateThemeSettings(
  patch: Partial<Pick<UserThemeSettings, 'fontSize' | 'textColor' | 'accentColor'>>,
): Promise<UserThemeSettings> {
  return request<UserThemeSettings>('/api/theme', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

export function uploadThemeBackground(file: File): Promise<UserThemeSettings> {
  const formData = new FormData()
  formData.append('background', file)
  return request<UserThemeSettings>('/api/theme/background', {
    method: 'POST',
    body: formData,
  })
}

export function deleteThemeBackground(): Promise<UserThemeSettings> {
  return request<UserThemeSettings>('/api/theme/background', {
    method: 'DELETE',
  })
}

export async function fetchThemeBackgroundBlob(
  userId: number,
  version: number,
  refresh = false,
): Promise<Blob> {
  const cacheKey = backgroundCacheKey(userId, version)
  const cache = typeof caches === 'undefined'
    ? null
    : await caches.open(BACKGROUND_CACHE_NAME).catch(() => null)
  if (!refresh) {
    const cached = await cache?.match(cacheKey).catch(() => undefined)
    if (cached) return cached.blob()
  }

  const response = await themeFetch(`/api/theme/background?v=${encodeURIComponent(version)}`)
  if (!response.ok) throw new Error(`Failed to load theme background (${response.status})`)
  const blob = await response.blob()
  if (cache) {
    const prefix = `/__hermes-theme-background/${userId}/`
    const requests = await cache.keys().catch(() => [])
    await Promise.all(requests
      .filter(entry => {
        const url = new URL(entry.url)
        return url.pathname.startsWith(prefix) && entry.url !== cacheKey
      })
      .map(entry => cache.delete(entry).catch(() => false)))
    await cache.put(
      cacheKey,
      new Response(blob, { headers: { 'Content-Type': blob.type } }),
    ).catch(() => undefined)
  }
  return blob
}

export async function clearThemeBackgroundCache(userId: number): Promise<void> {
  if (typeof caches === 'undefined') return
  const cache = await caches.open(BACKGROUND_CACHE_NAME).catch(() => null)
  if (!cache) return
  const prefix = `/__hermes-theme-background/${userId}/`
  const requests = await cache.keys().catch(() => [])
  await Promise.all(requests
    .filter(entry => new URL(entry.url).pathname.startsWith(prefix))
    .map(entry => cache.delete(entry).catch(() => false)))
}

export const STUDIO_VERSION_MANIFEST_URL = 'https://api.hermes-studio.ai/api/studio/versions'

export interface StudioMobileLinkChannel {
  url: string
  online: boolean
}

export interface StudioMobileRelease {
  version: string
  channels: {
    androidApk: {
      githubUrl: string
      cloudflareUrl: string
      online: boolean
    }
    googlePlay: StudioMobileLinkChannel
    apple: {
      testFlightUrl: string
      appStoreUrl: string
      online: boolean
    }
    harmony: StudioMobileLinkChannel
  }
}

export interface StudioVersionManifest {
  schema: 1
  hermes: string[]
  mobile: StudioMobileRelease
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStudioMobileRelease(value: unknown): value is StudioMobileRelease {
  if (!isRecord(value) || typeof value.version !== 'string' || !isRecord(value.channels)) return false
  const { androidApk, googlePlay, apple, harmony } = value.channels
  return isRecord(androidApk)
    && isRecord(googlePlay)
    && isRecord(apple)
    && isRecord(harmony)
}

export async function fetchStudioVersionManifest(): Promise<StudioVersionManifest> {
  const response = await fetch(STUDIO_VERSION_MANIFEST_URL, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`GET ${STUDIO_VERSION_MANIFEST_URL} returned ${response.status}`)
  const manifest: unknown = await response.json()
  if (!isRecord(manifest) || manifest.schema !== 1 || !isStudioMobileRelease(manifest.mobile)) {
    throw new Error('Invalid Studio version manifest')
  }
  return manifest as unknown as StudioVersionManifest
}

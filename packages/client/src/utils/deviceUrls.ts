const DEVICE_HTTP_PROTOCOL = 'http:'

function resolveDeviceHost(hostname?: string): string {
  const normalized = (hostname || '').trim()
  return normalized || 'localhost'
}

export function resolveDeviceUrls(hostname?: string) {
  const host = resolveDeviceHost(
    hostname || (typeof window !== 'undefined' ? window.location.hostname : 'localhost'),
  )

  return {
    provisioningUrl: `${DEVICE_HTTP_PROTOCOL}//${host}/`,
    businessUrl: `${DEVICE_HTTP_PROTOCOL}//${host}:6060/`,
  }
}

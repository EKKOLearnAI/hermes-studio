import { getApiKey, getBaseUrlValue } from '../client'

/**
 * Construct a download URL. Token is included by default because <a>/<img>
 * tags cannot set Authorization headers; omit it for persisted message state.
 */
export function getDownloadUrl(filePath: string, fileName?: string, options?: { includeToken?: boolean }): string {
  const base = getBaseUrlValue()
  const params = new URLSearchParams({ path: filePath })
  if (fileName) params.set('name', fileName)
  const token = options?.includeToken === false ? '' : getApiKey()
  if (token) params.set('token', token)
  return `${base}/api/hermes/download?${params.toString()}`
}

/**
 * Download a file. Uses fetch to detect errors, then creates a blob URL
 * for the browser download. Throws with error message on failure.
 */
export async function downloadFile(filePath: string, fileName?: string): Promise<void> {
  const url = getDownloadUrl(filePath, fileName)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Download failed: ${res.status}`)
  }
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = fileName || filePath.split('/').pop() || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(blobUrl)
}

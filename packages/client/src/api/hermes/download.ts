import { getApiKey, getBaseUrlValue } from '../client'

/**
 * Construct a download URL with auth token as query parameter.
 * Token is passed via query param because <a> tags cannot set headers.
 */
export function getDownloadUrl(filePath: string, fileName?: string): string {
  const base = getBaseUrlValue()

  // Guard: if filePath is already a full download URL, extract the real path
  // to prevent double-wrapping (/api/hermes/download?path=/api/hermes/download?path=...)
  if (filePath.startsWith('/api/hermes/download?')) {
    try {
      const parsed = new URL(filePath, 'http://localhost')
      const realPath = parsed.searchParams.get('path')
      if (realPath) filePath = realPath
    } catch {
      // fall through with original filePath
    }
  }

  // Decode the path first in case it's already encoded (e.g., from AI responses)
  // URLSearchParams will encode it again, so we need to start with decoded text
  const decodedPath = decodeURIComponent(filePath)
  const params = new URLSearchParams({ path: decodedPath })
  if (fileName) {
    const decodedName = decodeURIComponent(fileName)
    params.set('name', decodedName)
  }
  const token = getApiKey()
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

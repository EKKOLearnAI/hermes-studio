import { request, getApiKey, getBaseUrlValue } from '../client'

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modTime: string
}

export interface FileStat {
  name: string
  path: string
  isDir: boolean
  size: number
  modTime: string
  permissions?: string
}

export async function listFiles(path: string = ''): Promise<{ entries: FileEntry[]; path: string }> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const query = params.toString()
  return request<{ entries: FileEntry[]; path: string }>(`/api/hermes/files/list${query ? `?${query}` : ''}`)
}

export async function statFile(path: string): Promise<FileStat> {
  return request<FileStat>(`/api/hermes/files/stat?path=${encodeURIComponent(path)}`)
}

export async function readFile(path: string): Promise<{ content: string; path: string; size: number }> {
  return request<{ content: string; path: string; size: number }>(`/api/hermes/files/read?path=${encodeURIComponent(path)}`)
}

export async function writeFile(path: string, content: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/write', {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  })
}

export async function deleteFile(path: string, recursive: boolean = false): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/delete', {
    method: 'DELETE',
    body: JSON.stringify({ path, recursive }),
  })
}

export async function renameFile(oldPath: string, newPath: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/rename', {
    method: 'POST',
    body: JSON.stringify({ oldPath, newPath }),
  })
}

export async function mkDir(path: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/mkdir', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}

export async function copyFile(srcPath: string, destPath: string): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/copy', {
    method: 'POST',
    body: JSON.stringify({ srcPath, destPath }),
  })
}

export async function uploadFiles(targetDir: string, files: File[]): Promise<{ name: string; path: string }[]> {
  const base = getBaseUrlValue()
  const formData = new FormData()
  for (const file of files) {
    formData.append('file', file)
  }
  const params = new URLSearchParams()
  if (targetDir) params.set('path', targetDir)
  const query = params.toString()
  const url = `${base}/api/hermes/files/upload${query ? `?${query}` : ''}`

  const headers: Record<string, string> = {}
  const token = getApiKey()
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(url, { method: 'POST', headers, body: formData })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Upload failed: ${res.status}`)
  }
  const data = await res.json()
  return data.files
}

export function getFileDownloadUrl(relativePath: string, fileName?: string): string {
  const base = getBaseUrlValue()
  const params = new URLSearchParams({ path: relativePath })
  if (fileName) params.set('name', fileName)
  const token = getApiKey()
  if (token) params.set('token', token)
  return `${base}/api/hermes/download?${params.toString()}`
}

import { request, getBaseUrlValue, getApiKey } from '../client'

export interface HermesProfile {
  name: string
  active: boolean
  model: string
  gateway: string
  alias: string
}

export interface HermesProfileDetail {
  name: string
  path: string
  model: string
  provider: string
  gateway: string
  skills: number
  hasEnv: boolean
  hasSoulMd: boolean
}

export async function fetchProfiles(): Promise<HermesProfile[]> {
  const res = await request<{ profiles: HermesProfile[] }>('/api/hermes/profiles')
  return res.profiles
}

export async function fetchProfileDetail(name: string): Promise<HermesProfileDetail> {
  const res = await request<{ profile: HermesProfileDetail }>(`/api/hermes/profiles/${encodeURIComponent(name)}`)
  return res.profile
}

export interface CreateProfileResult {
  success: boolean
  /** clone=true 时被清理的独占平台凭据 KEY 名 */
  strippedCredentials?: string[]
  /** clone=true 时被禁用的独占平台名 */
  disabledPlatforms?: string[]
  /** clone=true 时在 config.yaml 中被清理的内嵌凭据字段路径 */
  strippedConfigCredentials?: string[]
}

export async function createProfile(name: string, clone?: boolean): Promise<CreateProfileResult> {
  try {
    const res = await request<{
      success: boolean
      strippedCredentials?: string[]
      disabledPlatforms?: string[]
      strippedConfigCredentials?: string[]
    }>('/api/hermes/profiles', {
      method: 'POST',
      body: JSON.stringify({ name, clone }),
    })
    return {
      success: !!res.success,
      strippedCredentials: res.strippedCredentials,
      disabledPlatforms: res.disabledPlatforms,
      strippedConfigCredentials: res.strippedConfigCredentials,
    }
  } catch {
    return { success: false }
  }
}

export async function deleteProfile(name: string): Promise<boolean> {
  try {
    await request(`/api/hermes/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' })
    return true
  } catch {
    return false
  }
}

export async function renameProfile(name: string, newName: string): Promise<boolean> {
  try {
    await request(`/api/hermes/profiles/${encodeURIComponent(name)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ new_name: newName }),
    })
    return true
  } catch {
    return false
  }
}

export async function switchProfile(name: string): Promise<boolean> {
  try {
    await request('/api/hermes/profiles/active', {
      method: 'PUT',
      body: JSON.stringify({ name }),
    })
    return true
  } catch {
    return false
  }
}

export async function exportProfile(name: string): Promise<boolean> {
  try {
    const baseUrl = getBaseUrlValue()
    const token = getApiKey()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(`${baseUrl}/api/hermes/profiles/${encodeURIComponent(name)}/export`, {
      method: 'POST',
      headers,
    })
    if (!res.ok) throw new Error()

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `hermes-profile-${name}.tar.gz`
    a.click()
    URL.revokeObjectURL(url)
    return true
  } catch {
    return false
  }
}

export async function importProfile(file: File): Promise<boolean> {
  try {
    const baseUrl = getBaseUrlValue()
    const token = getApiKey()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`

    const formData = new FormData()
    formData.append('file', file)

    const res = await fetch(`${baseUrl}/api/hermes/profiles/import`, {
      method: 'POST',
      headers,
      body: formData,
    })
    return res.ok
  } catch {
    return false
  }
}

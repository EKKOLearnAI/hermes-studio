import { request } from '../client'

export interface SkillBundleInfo {
  name: string
  commandName: string
  description: string
  skills: string[]
  instruction?: string
}

export interface CreateSkillBundleInput {
  name: string
  description?: string
  skills: string[]
}

function profileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : ''
}

export function skillBundleCommandName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function fetchSkillBundles(profile?: string): Promise<SkillBundleInfo[]> {
  const response = await request<{ bundles: SkillBundleInfo[] }>(`/api/hermes/bundles${profileQuery(profile)}`)
  return response.bundles ?? []
}

export async function createSkillBundleApi(profile: string | undefined, input: CreateSkillBundleInput): Promise<SkillBundleInfo> {
  const response = await request<{ bundle: SkillBundleInfo }>(`/api/hermes/bundles${profileQuery(profile)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return response.bundle
}

export async function deleteSkillBundleApi(profile: string | undefined, commandName: string): Promise<void> {
  await request(`/api/hermes/bundles/${encodeURIComponent(commandName)}${profileQuery(profile)}`, {
    method: 'DELETE',
  })
}

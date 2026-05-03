import { request } from '../client'

export type SkillSource = 'builtin' | 'hub' | 'local'

export interface SkillInfo {
  name: string
  description: string
  enabled?: boolean
  source?: SkillSource
  modified?: boolean
  patchCount?: number
  useCount?: number
  viewCount?: number
  pinned?: boolean
}

export interface SkillCategory {
  name: string
  description: string
  skills: SkillInfo[]
}

export interface SkillListResponse {
  categories: SkillCategory[]
  archived: SkillInfo[]
}

export interface SkillFileEntry {
  path: string
  name: string
  isDir: boolean
}

export interface MemoryData {
  memory: string
  user: string
  soul: string
  memory_mtime: number | null
  user_mtime: number | null
  soul_mtime: number | null
}

export interface SkillsData {
  categories: SkillCategory[]
  archived: SkillInfo[]
}

export async function fetchSkills(): Promise<SkillsData> {
  const res = await request<SkillListResponse>('/api/hermes/skills')
  return { categories: res.categories, archived: res.archived ?? [] }
}

export async function fetchSkillContent(skillPath: string): Promise<string> {
  const res = await request<{ content: string }>(`/api/hermes/skills/${skillPath}`)
  return res.content
}

export async function fetchSkillFiles(category: string, skill: string): Promise<SkillFileEntry[]> {
  const res = await request<{ files: SkillFileEntry[] }>(`/api/hermes/skills/${category}/${skill}/files`)
  return res.files
}

export async function fetchMemory(): Promise<MemoryData> {
  return request<MemoryData>('/api/hermes/memory')
}

export async function saveMemory(section: 'memory' | 'user' | 'soul', content: string): Promise<void> {
  await request('/api/hermes/memory', {
    method: 'POST',
    body: JSON.stringify({ section, content }),
  })
}

export async function toggleSkill(name: string, enabled: boolean): Promise<void> {
  await request('/api/hermes/skills/toggle', {
    method: 'PUT',
    body: JSON.stringify({ name, enabled }),
  })
}

export async function pinSkillApi(name: string, pinned: boolean): Promise<void> {
  await request('/api/hermes/skills/pin', {
    method: 'PUT',
    body: JSON.stringify({ name, pinned }),
  })
}

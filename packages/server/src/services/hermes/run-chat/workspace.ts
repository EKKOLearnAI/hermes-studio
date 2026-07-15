import { mkdir } from 'fs/promises'
import { join } from 'path'
import { getProfileDir } from '../hermes-profile'

export function defaultHermesWorkspace(profile: string): string {
  return join(getProfileDir(profile || 'default'), 'workspace')
}

export async function ensureHermesRunWorkspace(profile: string, workspace?: string | null): Promise<string> {
  const resolved = String(workspace || '').trim() || defaultHermesWorkspace(profile)
  await mkdir(resolved, { recursive: true })
  return resolved
}

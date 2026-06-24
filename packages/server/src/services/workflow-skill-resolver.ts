import { homedir } from 'os'
import { join, resolve } from 'path'
import { readdir, realpath } from 'fs/promises'
import { readConfigYamlForProfile, safeReadFile } from './config-helpers'
import { getProfileDir } from './hermes/hermes-profile'

export type WorkflowSkillTarget = 'hermes' | 'claude' | 'codex'

export interface ResolvedWorkflowSkill {
  name: string
  target: WorkflowSkillTarget
  path: string
  content: string
}

function targetForAgent(agent?: string | null): WorkflowSkillTarget {
  if (agent === 'claude-code') return 'claude'
  if (agent === 'codex') return 'codex'
  return 'hermes'
}

function expandConfiguredPath(value: string): string {
  const expandedEnv = value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    return process.env[braced || bare] || ''
  })
  if (expandedEnv === '~') return homedir()
  if (expandedEnv.startsWith('~/')) return join(homedir(), expandedEnv.slice(2))
  return expandedEnv
}

async function listVisibleDirectoryEntries(dir: string): Promise<Array<{ name: string; path: string }>> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, path: join(dir, entry.name) }))
}

async function findSkillDirByName(rootDir: string, skillName: string, visited = new Set<string>()): Promise<string | null> {
  const currentRealPath = await realpath(rootDir).catch(() => resolve(rootDir))
  if (visited.has(currentRealPath)) return null
  visited.add(currentRealPath)

  let entries: Array<{ name: string; path: string }>
  try {
    entries = await listVisibleDirectoryEntries(rootDir)
  } catch {
    return null
  }

  for (const entry of entries) {
    const skillMd = await safeReadFile(join(entry.path, 'SKILL.md'))
    if (skillMd !== null) {
      if (entry.name === skillName) return entry.path
      continue
    }
    const found = await findSkillDirByName(entry.path, skillName, visited)
    if (found) return found
  }
  return null
}

async function configuredHermesSkillRoots(profile: string): Promise<string[]> {
  const localSkillsDir = join(getProfileDir(profile || 'default'), 'skills')
  const config = await readConfigYamlForProfile(profile || 'default').catch(() => ({} as Record<string, any>))
  const rawDirs = config.skills?.external_dirs
  const entries = typeof rawDirs === 'string'
    ? [rawDirs]
    : Array.isArray(rawDirs)
      ? rawDirs
      : []
  const roots = [localSkillsDir]
  const localResolved = resolve(localSkillsDir)
  const seen = new Set([localResolved])
  for (const rawEntry of entries) {
    const entry = String(rawEntry || '').trim()
    if (!entry) continue
    const resolved = resolve(expandConfiguredPath(entry))
    if (seen.has(resolved)) continue
    seen.add(resolved)
    roots.push(resolved)
  }
  return roots
}

async function skillRootsForTarget(target: WorkflowSkillTarget, profile: string): Promise<string[]> {
  if (target === 'hermes') return configuredHermesSkillRoots(profile)
  if (target === 'claude') return [join(homedir(), '.claude', 'skills')]
  return [
    join(homedir(), '.agents', 'skills'),
    join(homedir(), '.codex', 'skills', '.system'),
  ]
}

export async function resolveWorkflowSkillContent(args: {
  agent?: string | null
  profile: string
  skillName: string
}): Promise<ResolvedWorkflowSkill | null> {
  const name = args.skillName.trim()
  if (!name) return null
  const target = targetForAgent(args.agent)
  for (const root of await skillRootsForTarget(target, args.profile)) {
    const skillDir = await findSkillDirByName(root, name)
    if (!skillDir) continue
    const content = await safeReadFile(join(skillDir, 'SKILL.md'))
    if (content !== null) {
      return { name, target, path: join(skillDir, 'SKILL.md'), content }
    }
  }
  return null
}

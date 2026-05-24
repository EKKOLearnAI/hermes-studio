import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import {
  readConfigYamlForProfile, updateConfigYamlForProfile,
  safeReadFile, extractDescription, listFilesRecursive,
} from '../../services/config-helpers'
import { isPathWithin } from '../../services/hermes/hermes-path'
import { getActiveProfileName, getProfileDir } from '../../services/hermes/hermes-profile'
import { getSkillUsageStatsFromDb } from '../../db/hermes/sessions-db'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function requestProfileDir(ctx: any): string {
  return getProfileDir(requestedProfile(ctx))
}

function requestSkillsDir(ctx: any): string {
  return join(requestProfileDir(ctx), 'skills')
}

/** Read bundled manifest as a name→hash map from ~/.hermes/skills/.bundled_manifest */
function readBundledManifest(manifestContent: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!manifestContent) return map
  for (const line of manifestContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx === -1) continue
    const name = trimmed.slice(0, idx).trim()
    const hash = trimmed.slice(idx + 1).trim()
    if (name && hash) map.set(name, hash)
  }
  return map
}

/** Read hub-installed skill names from ~/.hermes/skills/.hub/lock.json */
function readHubInstalledNames(lockContent: string | null): Set<string> {
  if (!lockContent) return new Set()
  try {
    const data = JSON.parse(lockContent)
    if (data?.installed && typeof data.installed === 'object') {
      return new Set(Object.keys(data.installed))
    }
  } catch { /* ignore */ }
  return new Set()
}

/** Compute md5 hash of all files in a directory (mirrors Hermes _dir_hash), with in-memory cache */
const hashCache = new Map<string, { hash: string; mtime: number }>()
const HASH_CACHE_TTL = 60_000 // 1 minute

async function dirHash(directory: string): Promise<string> {
  const cached = hashCache.get(directory)
  if (cached && Date.now() - cached.mtime < HASH_CACHE_TTL) return cached.hash

  const hasher = createHash('md5')
  const files = await listFilesRecursive(directory, '')
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  for (const f of files) {
    hasher.update(f.path)
    const content = await readFile(join(directory, f.path))
    hasher.update(content)
  }
  const hash = hasher.digest('hex')
  hashCache.set(directory, { hash, mtime: Date.now() })
  return hash
}

/** Determine the source type of a skill */
function getSkillSource(
  dirName: string,
  bundledManifest: Map<string, string>,
  hubNames: Set<string>,
): 'builtin' | 'hub' | 'local' {
  if (bundledManifest.has(dirName)) return 'builtin'
  if (hubNames.has(dirName)) return 'hub'
  return 'local'
}

/** Read .usage.json as a name→stats map */
interface UsageStats { patch_count: number; use_count: number; view_count: number; pinned: boolean }
function readUsageStats(usageContent: string | null): Map<string, UsageStats> {
  const map = new Map<string, UsageStats>()
  if (!usageContent) return map
  try {
    const data = JSON.parse(usageContent)
    for (const [name, stats] of Object.entries(data)) {
      const s = stats as any
      map.set(name, { patch_count: s.patch_count ?? 0, use_count: s.use_count ?? 0, view_count: s.view_count ?? 0, pinned: !!s.pinned })
    }
  } catch { /* ignore */ }
  return map
}

async function findSkillDirByName(rootDir: string, skillName: string): Promise<string | null> {
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue

    const entryPath = join(rootDir, entry.name)
    const skillMd = await safeReadFile(join(entryPath, 'SKILL.md'))
    if (skillMd !== null) {
      if (entry.name === skillName) return entryPath
      // This is another skill root. Do not search inside its references/scripts.
      continue
    }

    const found = await findSkillDirByName(entryPath, skillName)
    if (found) return found
  }

  return null
}

/**
 * Scan for skills at different directory depths.
 *
 * Supports both:
 *   - Three-level: skills/<category>/<skill-name>/SKILL.md  (category is a container)
 *   - Two-level:   skills/<skill-name>/SKILL.md            (flat skill under "misc" category)
 *
 * Categories are identified by having a DESCRIPTION.md at the category level
 * or by containing subdirectories with SKILL.md (three-level pattern).
 * Skills without a parent category (flat skills) are grouped under the "misc" category.
 */
async function scanSkillsDir(skillsDir: string, bundledManifest: Map<string, string>, hubNames: Set<string>, disabledList: string[], usageStats: Map<string, UsageStats>) {
  const allEntries = await readdir(skillsDir, { withFileTypes: true })
  const dirNames = allEntries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)

  // Classify directories: categories vs. flat skills
  const categoryDirs: { name: string; description: string }[] = []
  const flatSkills: { name: string; skillMd: string; source: string }[] = []

  for (const dirName of dirNames) {
    const catDir = join(skillsDir, dirName)
    const hasDesc = await safeReadFile(join(catDir, 'DESCRIPTION.md'))
    const hasSkillMd = await safeReadFile(join(catDir, 'SKILL.md'))
    const subEntries = await readdir(catDir, { withFileTypes: true })
    const subDirs = subEntries.filter(se => se.isDirectory())

    // Priority: SKILL.md at top level → flat skill
    //           DESCRIPTION.md or subdirs (without SKILL.md) → category
    if (hasSkillMd) {
      // Flat skill: has SKILL.md at the top level (two-level pattern)
      // Could also have subdirectories (references/, scripts/, etc.)
      flatSkills.push({
        name: dirName,
        skillMd: hasSkillMd,
        source: getSkillSource(dirName, bundledManifest, hubNames),
      })
    } else if (!!hasDesc || subDirs.length > 0) {
      // True category: has DESCRIPTION.md or subdirs, but no SKILL.md at top level
      const catDescription = hasDesc ? hasDesc.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) : ''
      categoryDirs.push({ name: dirName, description: catDescription })
    }
  }

  // Build categories with their nested skills
  const categories: any[] = []

  for (const cat of categoryDirs) {
    const catDir = join(skillsDir, cat.name)
    const subEntries = await readdir(catDir, { withFileTypes: true })
    const skills: any[] = []
    // Recursively collect skills from subdirectories (supports nested sub-categories)
    async function collectSkills(dir: string): Promise<any[]> {
      const entries = await readdir(dir, { withFileTypes: true })
      const results: any[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const entryPath = join(dir, entry.name)
        const skillMd = await safeReadFile(join(entryPath, 'SKILL.md'))
        if (skillMd) {
          const source = getSkillSource(entry.name, bundledManifest, hubNames)
          let modified = false
          if (source === 'builtin') {
            const manifestHash = bundledManifest.get(entry.name)
            if (manifestHash) {
              const currentHash = await dirHash(entryPath)
              modified = currentHash !== manifestHash
            }
          }
          const usage = usageStats.get(entry.name)
          results.push({
            name: entry.name,
            description: extractDescription(skillMd),
            enabled: !disabledList.includes(entry.name),
            source,
            modified: modified || undefined,
            patchCount: usage?.patch_count,
            useCount: usage?.use_count,
            viewCount: usage?.view_count,
            pinned: usage?.pinned || undefined,
          })
        } else {
          // No SKILL.md — might be a sub-category container, recurse deeper
          const subResults = await collectSkills(entryPath)
          results.push(...subResults)
        }
      }
      return results
    }
    skills.push(...await collectSkills(catDir))
    if (skills.length > 0) {
      categories.push({ name: cat.name, description: cat.description, skills })
    }
  }

  // Group flat skills into a "misc" (雜項) category
  if (flatSkills.length > 0) {
    const miscSkills: any[] = []
    for (const fs of flatSkills) {
      const usage = usageStats.get(fs.name)
      miscSkills.push({
        name: fs.name,
        description: extractDescription(fs.skillMd),
        enabled: !disabledList.includes(fs.name),
        source: fs.source,
        modified: undefined,
        patchCount: usage?.patch_count,
        useCount: usage?.use_count,
        viewCount: usage?.view_count,
        pinned: usage?.pinned || undefined,
      })
    }
    miscSkills.sort((a: any, b: any) => a.name.localeCompare(b.name))
    categories.push({
      name: 'misc',
      description: '雜項',
      skills: miscSkills,
    })
  }

  categories.sort((a, b) => a.name.localeCompare(b.name))
  for (const cat of categories) { cat.skills.sort((a: any, b: any) => a.name.localeCompare(b.name)) }
  return categories
}

export async function list(ctx: any) {
  const skillsDir = requestSkillsDir(ctx)
  try {
    const config = await readConfigYamlForProfile(requestedProfile(ctx))
    const disabledList: string[] = config.skills?.disabled || []

    // Read provenance sources
    const bundledManifest = readBundledManifest(await safeReadFile(join(skillsDir, '.bundled_manifest')))
    const hubNames = readHubInstalledNames(await safeReadFile(join(skillsDir, '.hub', 'lock.json')))
    const usageStats = readUsageStats(await safeReadFile(join(skillsDir, '.usage.json')))

    // Scan all skills (supports both two-level and three-level directory structures)
    const categories = await scanSkillsDir(skillsDir, bundledManifest, hubNames, disabledList, usageStats)

    // Read archived skills from .archive/
    const archived: any[] = []
    const archiveDir = join(skillsDir, '.archive')
    const archiveEntries = await readdir(archiveDir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[])
    for (const entry of archiveEntries) {
      if (!entry.isDirectory()) continue
      const skillMd = await safeReadFile(join(archiveDir, entry.name, 'SKILL.md'))
      if (skillMd) {
        const usage = usageStats.get(entry.name)
        archived.push({
          name: entry.name,
          description: extractDescription(skillMd),
          source: getSkillSource(entry.name, bundledManifest, hubNames),
          patchCount: usage?.patch_count,
          useCount: usage?.use_count,
          viewCount: usage?.view_count,
          pinned: usage?.pinned || undefined,
        })
      }
    }
    archived.sort((a: any, b: any) => a.name.localeCompare(b.name))

    ctx.body = { categories, archived }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `Failed to read skills directory: ${err.message}` }
  }
}

export async function usageStats(ctx: any) {
  const rawDays = parseInt(String(ctx.query?.days ?? '7'), 10)
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 7

  try {
    ctx.body = await getSkillUsageStatsFromDb(days, undefined, requestedProfile(ctx))
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `Failed to read skill usage stats: ${err.message}` }
  }
}

export async function toggle(ctx: any) {
  const { name, enabled } = ctx.request.body as { name?: string; enabled?: boolean }
  if (!name || typeof enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or enabled flag' }
    return
  }
  try {
    await updateConfigYamlForProfile(requestedProfile(ctx), (config) => {
      if (!config.skills) config.skills = {}
      if (!Array.isArray(config.skills.disabled)) config.skills.disabled = []
      const disabled = config.skills.disabled as string[]
      const idx = disabled.indexOf(name)
      if (enabled) { if (idx !== -1) disabled.splice(idx, 1) }
      else { if (idx === -1) disabled.push(name) }
      return config
    })
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function listFiles(ctx: any) {
  const { category, skill } = ctx.params
  const profileDir = requestProfileDir(ctx)
  const profileSkillsDir = join(profileDir, 'skills')
  const skillsDir = join(profileSkillsDir, category)
  if (category === 'misc') {
    const skillDir = join(profileSkillsDir, skill)
    try {
      const allFiles = await listFilesRecursive(skillDir, '')
      const files = allFiles.filter((f: any) => f.path !== 'SKILL.md')
      ctx.body = { files }
    } catch (err: any) {
      ctx.status = 500
      ctx.body = { error: err.message }
    }
    return
  }
  // Recursively find the actual skill directory (supports nested sub-categories like mlops/evaluation/lm-evaluation-harness)
  try {
    const skillDir = await findSkillDirByName(skillsDir, skill)
    if (!skillDir) {
      ctx.status = 404
      ctx.body = { error: 'Skill not found' }
      return
    }
    const allFiles = await listFilesRecursive(skillDir, '')
    const files = allFiles.filter((f: any) => f.path !== 'SKILL.md')
    ctx.body = { files }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function readFile_(ctx: any) {
  const filePath = (ctx.params as any).path
  const profileSkillsDir = join(requestProfileDir(ctx), 'skills')
  // Handle 'misc' category: real skill dir is skills/<skill>, not skills/misc/<skill>
  let realPath = filePath
  if (filePath.startsWith('misc/')) {
    realPath = filePath.slice(5)
  }
  const fullPath = resolve(join(profileSkillsDir, realPath))
  if (!isPathWithin(fullPath, profileSkillsDir)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  let content = await safeReadFile(fullPath)
  if (content === null) {
    // Fallback: recursive search for nested skills (e.g., mlops/lm-evaluation-harness/SKILL.md
    // where actual path is mlops/evaluation/lm-evaluation-harness/SKILL.md)
    const parts = filePath.split('/')
    if (parts.length >= 2) {
      const category = parts[0]
      const skillName = parts[1]
      const restPath = parts.slice(2).join('/')
      const catDir = join(profileSkillsDir, category)
      const skillDir = await findSkillDirByName(catDir, skillName)
      if (skillDir) {
        const resolvedPath = resolve(join(skillDir, restPath))
        if (isPathWithin(resolvedPath, skillDir)) {
          const nestedContent = await safeReadFile(resolvedPath)
          if (nestedContent !== null) {
            ctx.body = { content: nestedContent }
            return
          }
        }
      }
    }
    ctx.status = 404
    ctx.body = { error: 'File not found' }
    return
  }
  ctx.body = { content }
}

async function updatePinnedSkill(skillsDir: string, name: string, pinned: boolean): Promise<void> {
  await mkdir(skillsDir, { recursive: true })
  const usagePath = join(skillsDir, '.usage.json')
  let usage: Record<string, any> = {}
  const raw = await safeReadFile(usagePath)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) usage = parsed
    } catch { /* rewrite malformed usage file with the requested pin state */ }
  }
  const current = usage[name]
  usage[name] = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...current, pinned }
    : { patch_count: 0, use_count: 0, view_count: 0, pinned }
  await writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`, 'utf-8')
}

export async function pin_(ctx: any) {
  const { name, pinned } = ctx.request.body as { name?: string; pinned?: boolean }
  if (!name || typeof pinned !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or pinned flag' }
    return
  }
  try {
    await updatePinnedSkill(requestSkillsDir(ctx), name, pinned)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

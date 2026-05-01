import { readdir, readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import {
  readConfigYaml, writeConfigYaml,
  safeReadFile, extractDescription, listFilesRecursive, getHermesDir,
} from '../../services/config-helpers'
import { pinSkill } from '../../services/hermes/hermes-cli'

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

export async function list(ctx: any) {
  const skillsDir = join(getHermesDir(), 'skills')
  try {
    const config = await readConfigYaml()
    const disabledList: string[] = config.skills?.disabled || []

    // Read provenance sources
    const bundledManifest = readBundledManifest(await safeReadFile(join(skillsDir, '.bundled_manifest')))
    const hubNames = readHubInstalledNames(await safeReadFile(join(skillsDir, '.hub', 'lock.json')))
    const usageStats = readUsageStats(await safeReadFile(join(skillsDir, '.usage.json')))

    const entries = await readdir(skillsDir, { withFileTypes: true })
    const categories: any[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const catDir = join(skillsDir, entry.name)
      const catDesc = await safeReadFile(join(catDir, 'DESCRIPTION.md'))
      const catDescription = catDesc ? catDesc.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) : ''
      const skillEntries = await readdir(catDir, { withFileTypes: true })
      const skills: any[] = []
      for (const se of skillEntries) {
        if (!se.isDirectory()) continue
        const skillMd = await safeReadFile(join(catDir, se.name, 'SKILL.md'))
        if (skillMd) {
          const source = getSkillSource(se.name, bundledManifest, hubNames)

          // Check if builtin skill has been user-modified
          let modified = false
          if (source === 'builtin') {
            const manifestHash = bundledManifest.get(se.name)
            if (manifestHash) {
              const currentHash = await dirHash(join(catDir, se.name))
              modified = currentHash !== manifestHash
            }
          }

          const usage = usageStats.get(se.name)

          skills.push({
            name: se.name,
            description: extractDescription(skillMd),
            enabled: !disabledList.includes(se.name),
            source,
            modified: modified || undefined,
            patchCount: usage?.patch_count,
            useCount: usage?.use_count,
            viewCount: usage?.view_count,
            pinned: usage?.pinned || undefined,
          })
        }
      }
      if (skills.length > 0) {
        categories.push({ name: entry.name, description: catDescription, skills })
      }
    }
    categories.sort((a, b) => a.name.localeCompare(b.name))
    for (const cat of categories) { cat.skills.sort((a: any, b: any) => a.name.localeCompare(b.name)) }

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

export async function toggle(ctx: any) {
  const { name, enabled } = ctx.request.body as { name?: string; enabled?: boolean }
  if (!name || typeof enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or enabled flag' }
    return
  }
  try {
    const config = await readConfigYaml()
    if (!config.skills) config.skills = {}
    if (!Array.isArray(config.skills.disabled)) config.skills.disabled = []
    const disabled = config.skills.disabled as string[]
    const idx = disabled.indexOf(name)
    if (enabled) { if (idx !== -1) disabled.splice(idx, 1) }
    else { if (idx === -1) disabled.push(name) }
    await writeConfigYaml(config)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function listFiles(ctx: any) {
  const { category, skill } = ctx.params
  const skillDir = join(getHermesDir(), 'skills', category, skill)
  try {
    const allFiles = await listFilesRecursive(skillDir, '')
    const files = allFiles.filter(f => f.path !== 'SKILL.md')
    ctx.body = { files }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function readFile_(ctx: any) {
  const filePath = (ctx.params as any).path
  const hd = getHermesDir()
  const fullPath = resolve(join(hd, 'skills', filePath))
  if (!fullPath.startsWith(join(hd, 'skills'))) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  const content = await safeReadFile(fullPath)
  if (content === null) {
    ctx.status = 404
    ctx.body = { error: 'File not found' }
    return
  }
  ctx.body = { content }
}

export async function pin_(ctx: any) {
  const { name, pinned } = ctx.request.body as { name?: string; pinned?: boolean }
  if (!name || typeof pinned !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or pinned flag' }
    return
  }
  try {
    await pinSkill(name, pinned)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

import { readdir, readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { detectHermesHome } from './hermes-path'
import { safeReadFile, extractDescription } from '../config-helpers'

export interface SlashCommandEntryDto {
  name: string
  description: string
  type: 'bundle' | 'skill'
  /** e.g. "/study" for bundles, "/plan" for skills */
  command: string
}

/**
 * Parse a skill bundle YAML from ~/.hermes/skill-bundles/<name>.yaml
 */
function parseBundleName(filename: string): string | null {
  if (!filename.endsWith('.yaml') && !filename.endsWith('.yml')) return null
  const name = filename.replace(/\.ya?ml$/, '')
  if (!name || name.startsWith('.')) return null
  return name
}

function extractBundleDescription(content: string): string {
  // Try YAML frontmatter description field
  const descMatch = content.match(/^\s*description\s*:\s*["']?(.+?)["']?\s*$/m)
  if (descMatch) return descMatch[1].trim()
  // Fallback: first non-empty line
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      return trimmed.slice(0, 120)
    }
  }
  return ''
}

/**
 * List all skill bundles from ~/.hermes/skill-bundles/
 */
async function listBundles(hermesHome: string): Promise<SlashCommandEntryDto[]> {
  const bundlesDir = join(hermesHome, 'skill-bundles')
  try {
    const info = await stat(bundlesDir)
    if (!info.isDirectory()) return []
  } catch {
    return []
  }

  const entries = await readdir(bundlesDir, { withFileTypes: true })
  const results: SlashCommandEntryDto[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name = parseBundleName(entry.name)
    if (!name) continue

    let description = ''
    try {
      const content = await readFile(join(bundlesDir, entry.name), 'utf-8')
      description = extractBundleDescription(content)
    } catch {
      description = ''
    }

    results.push({
      name,
      description: description || 'Skill bundle',
      type: 'bundle',
      command: `/${name}`,
    })
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

/**
 * Extract installed skill names from the skills listing that the
 * existing skills API already provides. Since the skills API is
 * already used by the client, we just return the command slug for
 * each skill so the client can merge them.
 *
 * Skills with names that are not valid slash-command slugs are
 * skipped.
 */
function skillToSlug(skillName: string): string | null {
  const slug = skillName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || null
}

export interface SlashCommandsResponse {
  bundles: SlashCommandEntryDto[]
}

/**
 * List all available slash commands:
 *   - Bundles from ~/.hermes/skill-bundles/*.yaml
 */
export async function listSlashCommands(): Promise<SlashCommandsResponse> {
  const hermesHome = resolve(detectHermesHome())
  const bundles = await listBundles(hermesHome)

  return { bundles }
}

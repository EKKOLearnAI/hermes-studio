import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { AgentTool, AgentToolResult } from './types'

interface SkillListInput extends Record<string, unknown> {
  query?: string
  limit?: number
}

interface SkillViewInput extends Record<string, unknown> {
  name: string
}

interface DiscoveredSkill {
  name: string
  description: string
  content: string
}

const DEFAULT_SKILL_LIST_LIMIT = 50
const MAX_SKILL_LIST_LIMIT = 200

export class SkillListTool implements AgentTool<SkillListInput> {
  constructor(private readonly skillDirectory?: string) {}

  readonly definition = {
    name: 'skill_list',
    description: 'List or search skills in this Ekko Agent instance\'s configured skill directory. Use this before skill_view when a task may benefit from specialized instructions.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional case-insensitive search across skill names and descriptions.',
        },
        limit: {
          type: 'number',
          description: `Maximum results to return. Defaults to ${DEFAULT_SKILL_LIST_LIMIT}, maximum ${MAX_SKILL_LIST_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
  }

  async execute(input: SkillListInput): Promise<AgentToolResult> {
    const query = String(input.query || '').trim().toLowerCase()
    const requestedLimit = Number(input.limit)
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(MAX_SKILL_LIST_LIMIT, Math.floor(requestedLimit)))
      : DEFAULT_SKILL_LIST_LIMIT
    const discovered = await discoverSkills(this.skillDirectory)
    const matches = discovered
      .filter(skill => !query || `${skill.name}\n${skill.description}`.toLowerCase().includes(query))
      .slice(0, limit)
      .map(({ name, description }) => ({ name, description }))
    const payload = {
      query: query || undefined,
      count: matches.length,
      total: discovered.length,
      skills: matches,
      next: matches.length
        ? 'Call skill_view with an exact skill name to load its instructions.'
        : 'Try a broader query or call skill_list without a query.',
    }

    return {
      ok: true,
      content: JSON.stringify(payload, null, 2),
      data: payload,
    }
  }
}

export class SkillViewTool implements AgentTool<SkillViewInput> {
  constructor(private readonly skillDirectory?: string) {}

  readonly definition = {
    name: 'skill_view',
    description: 'Load the complete SKILL.md instructions for one skill in this Ekko Agent instance\'s configured skill directory. Use skill_list first to discover the exact skill name.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact skill name returned by skill_list.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  }

  async execute(input: SkillViewInput): Promise<AgentToolResult> {
    if (!configuredSkillDirectory(this.skillDirectory)) return emptyResult()
    const requestedName = String(input.name || '').trim()
    if (!requestedName) return failure('skill_view requires an exact skill name.')

    const skill = (await discoverSkills(this.skillDirectory))
      .find(candidate => candidate.name.toLowerCase() === requestedName.toLowerCase())
    if (!skill) {
      return failure(`Skill not found: ${requestedName}. Call skill_list to discover available skills.`)
    }

    return {
      ok: true,
      content: `[skill_view] name=${skill.name} (${skill.content.length} chars)\n${skill.content}`,
      data: {
        name: skill.name,
        description: skill.description,
        characters: skill.content.length,
      },
    }
  }
}

export function createSkillTools(skillDirectory?: string): AgentTool[] {
  return [
    new SkillListTool(skillDirectory),
    new SkillViewTool(skillDirectory),
  ]
}

async function discoverSkills(skillDirectory?: string): Promise<DiscoveredSkill[]> {
  const directory = String(skillDirectory || '').trim()
  if (!directory) return []
  const skills = new Map<string, DiscoveredSkill>()
  const visited = new Set<string>()
  const root = resolve(directory)
  if (!await isDirectory(root)) return []
  await scanSkillDirectory(root, skills, visited)

  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name))
}

async function scanSkillDirectory(
  directory: string,
  skills: Map<string, DiscoveredSkill>,
  visited: Set<string>,
): Promise<void> {
  const realDirectory = await realpath(directory).catch(() => resolve(directory))
  if (visited.has(realDirectory)) return
  visited.add(realDirectory)

  const skillContent = await readText(join(directory, 'SKILL.md'))
  if (skillContent !== null) {
    const name = basename(directory)
    const key = name.toLowerCase()
    if (!skills.has(key)) {
      skills.set(key, {
        name,
        description: extractSkillDescription(skillContent),
        content: skillContent,
      })
    }
    return
  }

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const entryPath = join(directory, entry.name)
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (!await isDirectory(entryPath)) continue
    await scanSkillDirectory(entryPath, skills, visited)
  }
}

function extractSkillDescription(content: string): string {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (frontmatter) {
    const match = frontmatter[1].match(/^description:\s*(.+)$/im)
    const description = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (description && description !== '|' && description !== '>') return description.slice(0, 240)
  }

  const body = frontmatter ? content.slice(frontmatter[0].length) : content
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    return trimmed.slice(0, 240)
  }
  return ''
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function failure(message: string): AgentToolResult {
  return {
    ok: false,
    content: message,
    error: message,
  }
}

function configuredSkillDirectory(skillDirectory?: string): string | null {
  const directory = String(skillDirectory || '').trim()
  return directory || null
}

function emptyResult(): AgentToolResult {
  return {
    ok: true,
    content: '',
  }
}
